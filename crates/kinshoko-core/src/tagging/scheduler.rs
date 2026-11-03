//! 打标调度：选模型档位、下载与准备模型、逐张打标并按模型来源写入、暂停时结束会话归还显存、
//! 会话崩溃后重启。全部在一个后台线程里，不占用调用方线程；打标没完成时资料库照常读写。
//!
//! 全设备一个调度（ADR-0008 修订，#414）：同一时间只有一个打标会话；画师正在整理的库先打，其余按登记
//! 顺序轮流。调度器空闲时自己逐个询问各库，写入方不必通知它；叫醒只为早点开始。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::CommandError;
use crate::command_error::ErrorKind;
use crate::library::{Error as LibraryError, FactSource, Library, TaggingOutcome};

use super::libraries::TaggingLibraries;

use super::interpret::interpret;
use super::models::{HUGGING_FACE, ModelSpec, ModelStore, PrepareStage, catalog};
mod worker;

use super::foreground::ForegroundCheck;
use super::port::{
    Device, DeviceInfo, PreparedModel, SessionStopper, TagFailure, Tagger, TaggerSession,
};

/// CPU 档要给系统其他部分留下的内存。
const RAM_MARGIN: u64 = 1_500_000_000;
/// 一次从资料库取多少张待打标的图。
const BATCH: u32 = 16;

/// 调度配置。
#[derive(Debug, Clone)]
pub struct TaggingConfig {
    /// 本设备的模型目录（与资料库无关）。
    pub models_dir: PathBuf,
    /// 可用的模型，按优先顺序；取第一个本机条件满足的。
    pub models: Vec<ModelSpec>,
    /// 模型下载地址前缀。
    pub base_url: String,
    /// 下载失败、会话启动失败或崩溃后，等多久再试。
    pub retry_delay: Duration,
    /// 没有待打标的图时，隔多久再查一次资料库。
    pub poll_interval: Duration,
    /// 同一张图让会话崩溃这么多次后记为无法打标，不再重试。
    pub max_crashes_per_image: u32,
    /// 显卡被重置或会话在显卡上启动失败这么多次后，本次运行不再用显卡，退到 CPU 档。
    pub max_gpu_failures: u32,
    /// 画师在设置中选的硬件档：只用这一档的模型，本机条件不满足时不退到别的档。
    /// `None` 表示自动：按 `models` 的顺序取第一个本机条件满足的（显卡不可用时退到 CPU 档）。
    pub preferred: Option<Device>,
    /// Optional application publication boundary. Only result writes acquire it;
    /// model loading and inference stay outside. Stop/join callers must release it first.
    pub publication_gate: Option<Arc<Mutex<()>>>,
    /// 有全屏程序或演示模式时让出打标（#212）：返回真时结束会话、归还显存，每隔 `poll_interval`
    /// 再看一次，恢复后继续。为空时不检查。
    pub foreground: Option<ForegroundCheck>,
}

impl TaggingConfig {
    pub fn new(models_dir: PathBuf, models: Vec<ModelSpec>) -> TaggingConfig {
        TaggingConfig {
            models_dir,
            models,
            base_url: HUGGING_FACE.into(),
            retry_delay: Duration::from_secs(30),
            poll_interval: Duration::from_secs(1),
            max_crashes_per_image: 2,
            max_gpu_failures: 2,
            preferred: None,
            publication_gate: None,
            foreground: None,
        }
    }

    /// 内置模型、默认下载地址。
    pub fn with_catalog(models_dir: PathBuf) -> TaggingConfig {
        TaggingConfig::new(models_dir, catalog())
    }
}

/// 自动标签的当前状态，所有资料库合计，供界面显示。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum TaggingStatus {
    Starting,
    /// 本机条件不满足任何模型。
    #[serde(rename_all = "camelCase")]
    NoDevice {
        #[ts(as = "Vec<crate::command_error::ErrorKind>")]
        reasons: Vec<CommandError>,
    },
    /// 首次使用：模型还没下载，等画师确认（显示大小；`downloaded` 是上次中断时已下的部分）。
    /// `fallback` 是自动档退到这个模型的原因（例如没有独立显卡）；没有退让时为空。
    /// `cancelled`：画师刚取消了下载（#213），界面不再催下载。
    #[serde(rename_all = "camelCase")]
    NeedsDownload {
        model: String,
        #[ts(type = "number")]
        size: u64,
        #[ts(type = "number")]
        downloaded: u64,
        #[ts(as = "Option<Vec<crate::command_error::ErrorKind>>")]
        fallback: Option<Vec<CommandError>>,
        cancelled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Downloading {
        model: String,
        #[ts(type = "number")]
        downloaded: u64,
        #[ts(type = "number")]
        total: u64,
    },
    /// 校验哈希、改写为分块注意力。
    #[serde(rename_all = "camelCase")]
    Preparing {
        model: String,
    },
    /// 正在打标；`tagged` 是本次运行打过的张数，`gpu` 是在用的显卡（CPU 档为空）。
    /// 这一轮（从上次没有待打标的图算起）的进度是 `done / (done + remaining)`：`done` 是这一轮处理过的张数
    /// （含无法读取的图），`remaining` 是各库还没处理的张数合计（含正在打的这张）。
    #[serde(rename_all = "camelCase")]
    Running {
        model: String,
        device: Device,
        gpu: Option<String>,
        tagged: u32,
        done: u32,
        remaining: u32,
    },
    /// 能打开的资料库都没有待打标的图；会话已结束，不占显存。`tagged` 同 `Running`，含刚打完的最后一张。
    /// `unknown` 是暂时打不开、数不出未打标张数的资料库个数：不为 0 时不算已全部打完。
    #[serde(rename_all = "camelCase")]
    Idle {
        model: String,
        device: Device,
        gpu: Option<String>,
        tagged: u32,
        unknown: u32,
    },
    /// 画师暂停了打标；会话已结束，显存已归还。
    Paused,
    /// 有全屏程序或演示模式，自动让出（#212）；会话已结束，显存已归还，恢复后自己继续。
    YieldedToFullScreen,
    /// 出错，稍后自动重试。
    #[serde(rename_all = "camelCase")]
    Failed {
        #[ts(as = "crate::command_error::ErrorKind")]
        reason: CommandError,
    },
}

#[derive(Default)]
struct Control {
    paused: bool,
    stop: bool,
    /// 画师确认了下载（对当前选的模型；换硬件档或自动档退到另一个模型后要重新确认）。
    download: bool,
    /// 画师取消了下载（#213）；再确认下载时清掉。
    cancelled: bool,
    /// 见 [`TaggingConfig::preferred`]。
    preferred: Option<Device>,
    /// 画师正在整理的资料库，先打；见 [`Tagging::prefer`]。
    library: Option<String>,
}

struct Shared {
    control: Mutex<Control>,
    wake: Condvar,
    status: Mutex<TaggingStatus>,
    /// 打断正在进行的下载（暂停、取消下载或停止时），已下载的部分保留。在持有 `control` 时置位，
    /// 后台线程也在持有 `control` 并确认可以下载后才清掉，不会漏掉一次打断。
    cancel: AtomicBool,
    /// 当前会话的结束开关；暂停或停止时立即结束会话，不等手上那张图。
    stopper: Mutex<Option<SessionStopper>>,
    /// 正在打的这一批属于哪个资料库；没有在打时为空。
    tagging: Mutex<Option<String>>,
    /// `tagging` 变化时通知，[`Tagging::release`] 在上面等这一批放下资料库。
    tagging_changed: Condvar,
    /// 这一批的资料库取消了登记（[`Tagging::release`]）：和暂停一样中止这一批，不算出错。
    released: AtomicBool,
}

impl Shared {
    /// 立即结束当前会话（若有）。
    fn stop_session(&self) {
        let stopper = self
            .stopper
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(stop) = stopper {
            stop();
        }
    }

    fn set_stopper(&self, stopper: Option<SessionStopper>) {
        *self.stopper.lock().unwrap_or_else(|e| e.into_inner()) = stopper;
    }

    /// 登记新会话的结束开关（会话开始加载之前）。已经暂停或停止时立即结束它：暂停先置位再取开关，
    /// 这里先占住开关再看是否已暂停，两边至少有一边会按到开关，不会漏掉。
    fn register_stopper(&self, stopper: SessionStopper) {
        let mut slot = self.stopper.lock().unwrap_or_else(|e| e.into_inner());
        if self.interrupted() {
            drop(slot);
            stopper();
        } else {
            *slot = Some(stopper);
        }
    }

    fn control(&self) -> MutexGuard<'_, Control> {
        self.control.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, status: TaggingStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    fn set_tagging(&self, library_id: Option<String>) {
        let mut tagging = self.tagging.lock().unwrap_or_else(|e| e.into_inner());
        *tagging = library_id;
        self.released.store(false, Ordering::SeqCst);
        drop(tagging);
        self.tagging_changed.notify_all();
    }

    /// 等到被唤醒或超时；返回时可能已暂停或停止。
    fn sleep(&self, timeout: Duration) {
        let control = self.control();
        if control.stop {
            return;
        }
        let _ = self.wake.wait_timeout(control, timeout);
    }

    /// 持有 `control` 时改控制并置位 `cancel`，打断正在进行的下载，再唤醒后台线程。
    fn interrupt(&self, change: impl FnOnce(&mut Control)) {
        let mut control = self.control();
        change(&mut control);
        self.cancel.store(true, Ordering::Relaxed);
        drop(control);
        self.wake.notify_all();
    }

    /// 暂停、停止，或这一批的资料库取消了登记。
    fn interrupted(&self) -> bool {
        let c = self.control();
        c.stop || c.paused || self.released.load(Ordering::SeqCst)
    }
}

/// 自动标签服务，覆盖 `libraries` 给出的全部资料库。丢弃即停止（结束会话、取消下载）。
pub struct Tagging {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Tagging {
    /// 在后台开始为 `libraries` 里的资料库打标。
    pub fn start(
        libraries: Arc<dyn TaggingLibraries>,
        tagger: Arc<dyn Tagger>,
        config: TaggingConfig,
    ) -> Tagging {
        let shared = Arc::new(Shared {
            control: Mutex::new(Control {
                preferred: config.preferred,
                ..Control::default()
            }),
            wake: Condvar::new(),
            status: Mutex::new(TaggingStatus::Starting),
            cancel: AtomicBool::new(false),
            stopper: Mutex::new(None),
            tagging: Mutex::new(None),
            tagging_changed: Condvar::new(),
            released: AtomicBool::new(false),
        });
        let worker = Worker {
            store: ModelStore::new(config.models_dir.clone(), &config.base_url),
            shared: shared.clone(),
            libraries,
            tagger,
            config,
            device_info: None,
            gpu_failures: 0,
            crashes: HashMap::new(),
            session: None,
            tagged: 0,
            done: 0,
            remaining: 0,
            chosen: None,
        };
        let thread = std::thread::Builder::new()
            .name("kinshoko-tagging".into())
            .spawn(move || worker.run())
            .expect("无法启动打标调度线程");
        Tagging {
            shared,
            thread: Some(thread),
        }
    }

    pub fn status(&self) -> TaggingStatus {
        self.shared
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 画师确认后开始下载模型（可续传）。之后模型缺失时会自动重新下载。
    pub fn download(&self) {
        let mut control = self.shared.control();
        control.download = true;
        control.cancelled = false;
        drop(control);
        self.shared.wake.notify_all();
    }

    /// 暂停打标：立即结束会话（打标子进程），归还显存。打到一半的那张恢复后重打。
    /// 正在下载模型时停下下载，已下的部分保留，恢复后从断点续传（#213）。
    pub fn pause(&self) {
        self.shared.interrupt(|c| c.paused = true);
        self.shared.stop_session();
    }

    /// 取消下载（#213）：停下下载，回到等画师确认的需要下载；已下的部分保留，再确认时从断点续传。
    pub fn cancel_download(&self) {
        self.shared.interrupt(|c| {
            c.download = false;
            c.cancelled = true;
        });
    }

    /// 换用画师在设置中选的硬件档（`None` 为自动）。这一档的模型还没下载时先显示大小，等画师确认；
    /// 已经打过的图不重打（同一模型的不同硬件档共用一个来源）。
    pub fn set_device(&self, device: Option<Device>) {
        let mut control = self.shared.control();
        if control.preferred != device {
            control.preferred = device;
            control.download = false;
        }
        drop(control);
        self.shared.wake.notify_all();
    }

    pub fn resume(&self) {
        self.shared.control().paused = false;
        self.shared.wake.notify_all();
    }

    /// 有新图时立即检查，不等下一次轮询。不调用也不会漏，只是晚一点开始。
    pub fn wake(&self) {
        self.shared.wake.notify_all();
    }

    /// 画师正在整理这个库：下一批先从它取（不打断手上这一批）。不调用也会轮到它。
    pub fn prefer(&self, library_id: &str) {
        let mut control = self.shared.control();
        if control.library.as_deref() == Some(library_id) {
            return;
        }
        control.library = Some(library_id.to_owned());
        drop(control);
        self.shared.wake.notify_all();
    }

    /// 资料库取消了登记：正在打它的这一批立即中止（结束会话，打到一半的结果不写），等到调度器放下
    /// 它的句柄再返回，之后它的文件夹可以移动。调用方先从登记表里移除它，并放开发布闸门；
    /// 调度器不会再列出它。没在打这个库时立即返回。
    pub fn release(&self, library_id: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut tagging = self
            .shared
            .tagging
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if tagging.as_deref() != Some(library_id) {
            return;
        }
        self.shared.released.store(true, Ordering::SeqCst);
        self.shared.stop_session();
        while tagging.as_deref() == Some(library_id) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return;
            }
            tagging = self
                .shared
                .tagging_changed
                .wait_timeout(tagging, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// 正在打的这一批属于哪个资料库（记运行日志用）；没有在打时为空。
    pub fn tagging_library(&self) -> Option<String> {
        self.shared
            .tagging
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl Drop for Tagging {
    fn drop(&mut self) {
        self.shared.interrupt(|c| c.stop = true);
        self.shared.stop_session();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Worker {
    shared: Arc<Shared>,
    libraries: Arc<dyn TaggingLibraries>,
    tagger: Arc<dyn Tagger>,
    config: TaggingConfig,
    store: ModelStore,
    device_info: Option<DeviceInfo>,
    gpu_failures: u32,
    /// （资料库, 参考图）→ 让会话崩溃过几次。
    crashes: HashMap<(String, String), u32>,
    session: Option<(String, Box<dyn TaggerSession>)>,
    tagged: u32,
    /// 见 [`TaggingStatus::Running`]。
    done: u32,
    remaining: u32,
    /// 上一次选中的模型 key；自动档换到另一个模型时，之前的下载确认不再算数。
    chosen: Option<String>,
}

/// 这一步从各库取到的：要打的一批（资料库与参考图）、各库未打标张数合计、数不出来的库个数。
#[derive(Default)]
struct Pick {
    batch: Option<(Arc<Library>, Vec<String>)>,
    remaining: u32,
    unknown: u32,
}

/// 选中的模型；`fallback` 是自动档跳过前面模型的原因。
struct Choice {
    spec: ModelSpec,
    fallback: Option<Vec<CommandError>>,
}
