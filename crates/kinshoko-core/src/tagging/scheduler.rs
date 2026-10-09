//! 打标调度：选模型档位、下载与准备模型、逐张打标并按模型来源写入、暂停时结束会话归还显存、
//! 会话崩溃后重启。全部在一个后台线程里，不占用调用方线程；打标没完成时资料库照常读写。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::library::{Error as LibraryError, FactSource, Library, TaggingOutcome};

use super::interpret::interpret;
use super::models::{HUGGING_FACE, ModelSpec, ModelStore, PrepareStage, catalog};
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
    /// 画师在设置中选的模型（[`ModelSpec::key`]）：本机条件满足时优先用它，否则按 `models`
    /// 的顺序退让（例如选了显卡模型但没有独显）。`None` 表示自动选择。
    pub preferred: Option<String>,
    /// Optional application publication boundary. Only result writes acquire it;
    /// model loading and inference stay outside. Stop/join callers must release it first.
    pub publication_gate: Option<Arc<Mutex<()>>>,
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
        }
    }

    /// 内置模型、默认下载地址。
    pub fn with_catalog(models_dir: PathBuf) -> TaggingConfig {
        TaggingConfig::new(models_dir, catalog())
    }
}

/// 状态与所属资料库一起传给界面，迟到推送不能覆盖另一个库的状态。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryTaggingStatus {
    pub library_id: String,
    pub status: TaggingStatus,
}

/// 自动标签的当前状态，供界面显示。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum TaggingStatus {
    Starting,
    /// 本机条件不满足任何模型。
    #[serde(rename_all = "camelCase")]
    NoDevice {
        reason: String,
    },
    /// 首次使用：模型还没下载，等画师确认（显示大小；`downloaded` 是上次中断时已下的部分）。
    #[serde(rename_all = "camelCase")]
    NeedsDownload {
        model: String,
        #[ts(type = "number")]
        size: u64,
        #[ts(type = "number")]
        downloaded: u64,
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
    /// 正在打标；`tagged` 是本次运行打过的张数。
    #[serde(rename_all = "camelCase")]
    Running {
        model: String,
        device: Device,
        tagged: u32,
    },
    /// 没有待打标的图；会话已结束，不占显存。
    #[serde(rename_all = "camelCase")]
    Idle {
        model: String,
        device: Device,
    },
    /// 画师暂停了打标；会话已结束，显存已归还。
    Paused,
    /// 出错，稍后自动重试。
    #[serde(rename_all = "camelCase")]
    Failed {
        reason: String,
    },
}

#[derive(Default)]
struct Control {
    paused: bool,
    stop: bool,
    /// 画师确认了下载（对当前选的模型；换模型后要重新确认）。
    download: bool,
    /// 见 [`TaggingConfig::preferred`]。
    preferred: Option<String>,
}

struct Shared {
    control: Mutex<Control>,
    wake: Condvar,
    status: Mutex<TaggingStatus>,
    /// 停止时取消下载。
    cancel: AtomicBool,
    /// 当前会话的结束开关；暂停或停止时立即结束会话，不等手上那张图。
    stopper: Mutex<Option<SessionStopper>>,
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

    /// 等到被唤醒或超时；返回时可能已暂停或停止。
    fn sleep(&self, timeout: Duration) {
        let control = self.control();
        if control.stop {
            return;
        }
        let _ = self.wake.wait_timeout(control, timeout);
    }

    fn interrupted(&self) -> bool {
        let c = self.control();
        c.stop || c.paused
    }
}

/// 自动标签服务。丢弃即停止（结束会话、取消下载）。
pub struct Tagging {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Tagging {
    /// 在后台开始为 `library` 打标。
    pub fn start(library: Arc<Library>, tagger: Arc<dyn Tagger>, config: TaggingConfig) -> Tagging {
        let shared = Arc::new(Shared {
            control: Mutex::new(Control {
                preferred: config.preferred.clone(),
                ..Control::default()
            }),
            wake: Condvar::new(),
            status: Mutex::new(TaggingStatus::Starting),
            cancel: AtomicBool::new(false),
            stopper: Mutex::new(None),
        });
        let worker = Worker {
            store: ModelStore::new(config.models_dir.clone(), &config.base_url),
            shared: shared.clone(),
            library,
            tagger,
            config,
            device_info: None,
            gpu_failures: 0,
            crashes: HashMap::new(),
            session: None,
            tagged: 0,
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
        self.shared.control().download = true;
        self.shared.wake.notify_all();
    }

    /// 暂停打标：立即结束会话（打标子进程），归还显存。打到一半的那张恢复后重打。
    pub fn pause(&self) {
        self.shared.control().paused = true;
        self.shared.stop_session();
        self.shared.wake.notify_all();
    }

    /// 换用画师在设置中选的模型（`None` 为自动）。新模型还没下载时先显示大小，等画师确认；
    /// 已经打过的图不重打（同一模型的不同精度共用一个来源）。
    pub fn set_model(&self, key: Option<String>) {
        let mut control = self.shared.control();
        if control.preferred != key {
            control.preferred = key;
            control.download = false;
        }
        drop(control);
        self.shared.wake.notify_all();
    }

    pub fn resume(&self) {
        self.shared.control().paused = false;
        self.shared.wake.notify_all();
    }

    /// 有新图时立即检查，不等下一次轮询。
    pub fn wake(&self) {
        self.shared.wake.notify_all();
    }
}

impl Drop for Tagging {
    fn drop(&mut self) {
        self.shared.control().stop = true;
        self.shared.cancel.store(true, Ordering::Relaxed);
        self.shared.stop_session();
        self.shared.wake.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Worker {
    shared: Arc<Shared>,
    library: Arc<Library>,
    tagger: Arc<dyn Tagger>,
    config: TaggingConfig,
    store: ModelStore,
    device_info: Option<DeviceInfo>,
    gpu_failures: u32,
    /// 参考图 → 让会话崩溃过几次。
    crashes: HashMap<String, u32>,
    session: Option<(String, Box<dyn TaggerSession>)>,
    tagged: u32,
}

impl Worker {
    fn run(mut self) {
        loop {
            let (stop, paused) = {
                let c = self.shared.control();
                (c.stop, c.paused)
            };
            if stop {
                break;
            }
            if paused {
                self.end_session();
                self.shared.set(TaggingStatus::Paused);
                let c = self.shared.control();
                if c.paused && !c.stop {
                    drop(self.shared.wake.wait(c));
                }
                continue;
            }
            self.step();
        }
        self.end_session();
    }

    /// 结束会话（打标子进程），归还显存。
    fn end_session(&mut self) {
        self.shared.set_stopper(None);
        self.session = None;
    }

    fn gpu_usable(&self) -> bool {
        self.gpu_failures < self.config.max_gpu_failures
    }

    /// 本机条件满足的第一个模型；画师选的模型排在最前。
    fn choose(&mut self) -> Result<ModelSpec, String> {
        let info = self
            .device_info
            .get_or_insert_with(|| self.tagger.probe())
            .clone();
        let preferred = self.shared.control().preferred.clone();
        let mut order: Vec<&ModelSpec> = self.config.models.iter().collect();
        order.sort_by_key(|spec| Some(&spec.key) != preferred.as_ref());
        let mut reasons = Vec::new();
        for spec in order {
            match spec.device {
                Device::DirectMl => match &info.gpu {
                    None => reasons.push("没有独立显卡".to_owned()),
                    Some(_) if !self.gpu_usable() => {
                        reasons.push("显卡多次出错，本次不再使用".to_owned())
                    }
                    Some(gpu) if gpu.vram_budget < spec.vram_need / 4 * 5 => {
                        reasons.push(format!("{} 的显存额度不够 {}", gpu.name, spec.label))
                    }
                    Some(_) => return Ok(spec.clone()),
                },
                Device::Cpu => {
                    if spec.ram_need == 0 || info.available_ram >= spec.ram_need + RAM_MARGIN {
                        return Ok(spec.clone());
                    }
                    reasons.push(format!("可用内存不够 {}", spec.label));
                }
            }
        }
        Err(if reasons.is_empty() {
            "没有可用的打标模型".into()
        } else {
            reasons.join("；")
        })
    }

    fn step(&mut self) {
        let spec = match self.choose() {
            Ok(spec) => spec,
            Err(reason) => {
                self.end_session();
                self.shared.set(TaggingStatus::NoDevice { reason });
                // 内存可能稍后够用，重新探测。
                self.device_info = None;
                self.shared.sleep(self.config.retry_delay);
                return;
            }
        };
        let Some(model) = self.model(&spec) else {
            return;
        };
        let source = FactSource::model(&spec.source);
        let ids = match self.library.images_to_tag(&source, BATCH) {
            Ok(ids) => ids,
            Err(e) => return self.fail(format!("读取待打标的图失败：{e}")),
        };
        if ids.is_empty() {
            self.end_session();
            self.shared.set(TaggingStatus::Idle {
                model: spec.label.clone(),
                device: spec.device,
            });
            self.shared.sleep(self.config.poll_interval);
            return;
        }
        for id in ids {
            if self.shared.interrupted() {
                return;
            }
            if !self.tag_one(&model, &source, &id) {
                return;
            }
        }
    }

    /// 模型就绪时返回；否则显示需要下载或下载进度，返回 `None`。
    fn model(&mut self, spec: &ModelSpec) -> Option<PreparedModel> {
        if let Some(model) = self.store.ready(spec) {
            return Some(model);
        }
        self.end_session();
        if !self.shared.control().download {
            self.shared.set(TaggingStatus::NeedsDownload {
                model: spec.label.clone(),
                size: spec.download_size(),
                downloaded: self.store.downloaded(spec),
            });
            self.shared.sleep(self.config.poll_interval);
            return None;
        }
        let shared = self.shared.clone();
        let label = spec.label.clone();
        let mut progress = |stage: PrepareStage| {
            shared.set(match stage {
                PrepareStage::Downloading { downloaded, total } => TaggingStatus::Downloading {
                    model: label.clone(),
                    downloaded,
                    total,
                },
                PrepareStage::Verifying => TaggingStatus::Preparing {
                    model: label.clone(),
                },
            })
        };
        match self.store.prepare(spec, &mut progress, &self.shared.cancel) {
            Ok(model) => Some(model),
            Err(reason) => {
                self.fail(reason);
                None
            }
        }
    }

    fn fail(&mut self, reason: String) {
        self.end_session();
        self.shared.set(TaggingStatus::Failed { reason });
        self.shared.sleep(self.config.retry_delay);
    }

    /// 打一张图并写入。返回 `false` 表示这一批要中止（会话失效等）。
    fn tag_one(&mut self, model: &PreparedModel, source: &FactSource, id: &str) -> bool {
        let spec = &model.spec;
        let path = match self.library.original_to_tag(id) {
            Ok(path) => path,
            // 图在此期间被删除了。
            Err(LibraryError::UnknownImage) => return true,
            Err(e) => {
                self.fail(format!("读取原图位置失败：{e}"));
                return false;
            }
        };
        if self
            .session
            .as_ref()
            .is_none_or(|(key, _)| *key != spec.key)
        {
            self.end_session();
            let shared = self.shared.clone();
            let started = self.tagger.start(model, spec.device, &move |stopper| {
                shared.register_stopper(stopper)
            });
            match started {
                Ok(session) => {
                    self.session = Some((spec.key.clone(), session));
                }
                Err(_) if self.shared.interrupted() => {
                    // 加载中画师暂停（或关闭资料库）结束了子进程：不算出错，恢复后重新开始。
                    self.end_session();
                    return false;
                }
                Err(failure) => {
                    if spec.device == Device::DirectMl {
                        self.gpu_failures += 1;
                    }
                    self.fail(format!("无法开始打标：{failure}"));
                    return false;
                }
            }
            // 加载刚完成时画师暂停了：开关可能已被按过，这里确保会话结束。
            if self.shared.interrupted() {
                self.end_session();
                return false;
            }
        }
        self.shared.set(TaggingStatus::Running {
            model: spec.label.clone(),
            device: spec.device,
            tagged: self.tagged,
        });
        let (_, session) = self.session.as_mut().expect("会话已开始");
        let result = session.tag(&path);
        let written = match result {
            Ok(raw) => {
                let s = interpret(spec, &raw);
                // Only publication joins the application's final side-effect boundary.
                // Inference and model loading above must never hold it.
                let gate = self.config.publication_gate.clone();
                let publication = gate
                    .as_ref()
                    .map(|gate| gate.lock().unwrap_or_else(|error| error.into_inner()));
                if self.shared.interrupted() {
                    drop(publication);
                    self.end_session();
                    return false;
                }
                self.crashes.remove(id);
                self.tagged += 1;
                self.library
                    .replace_source_tags(source, id, &s.tags)
                    .and_then(|()| self.library.replace_source_rating(source, id, s.rating))
                    .and_then(|()| {
                        self.library
                            .finish_tagging(source, id, TaggingOutcome::Done)
                    })
            }
            Err(TagFailure::BadImage(reason)) => {
                self.library
                    .finish_tagging(source, id, TaggingOutcome::Failed(reason))
            }
            Err(_) if self.shared.interrupted() => {
                // 画师暂停（或停止）时结束了会话：这张不算出错，恢复后重打。
                self.end_session();
                return false;
            }
            Err(failure) => {
                // 会话已失效：结束它，稍后重启。
                self.end_session();
                if matches!(failure, TagFailure::DeviceLost(_)) && spec.device == Device::DirectMl {
                    // 输入尺寸固定，显卡重置或显存溢出不怪这张图：记在显卡头上，多次后退到 CPU 档。
                    self.gpu_failures += 1;
                    self.fail(failure.to_string());
                    return false;
                }
                let crashes = self.crashes.entry(id.to_owned()).or_default();
                *crashes += 1;
                if *crashes >= self.config.max_crashes_per_image {
                    self.crashes.remove(id);
                    let reason = format!("打标子进程在这张图上反复出错：{failure}");
                    let _ = self
                        .library
                        .finish_tagging(source, id, TaggingOutcome::Failed(reason));
                }
                self.fail(failure.to_string());
                return false;
            }
        };
        match written {
            Ok(()) | Err(LibraryError::UnknownImage) => true,
            Err(e) => {
                self.fail(format!("写入标签建议失败：{e}"));
                false
            }
        }
    }
}
