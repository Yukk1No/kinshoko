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
use super::port::{Device, DeviceInfo, PreparedModel, TagFailure, Tagger, TaggerSession};

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
        }
    }

    /// 内置模型、默认下载地址。
    pub fn with_catalog(models_dir: PathBuf) -> TaggingConfig {
        TaggingConfig::new(models_dir, catalog())
    }
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
    download: bool,
}

struct Shared {
    control: Mutex<Control>,
    wake: Condvar,
    status: Mutex<TaggingStatus>,
    /// 停止时取消下载。
    cancel: AtomicBool,
}

impl Shared {
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
            control: Mutex::default(),
            wake: Condvar::new(),
            status: Mutex::new(TaggingStatus::Starting),
            cancel: AtomicBool::new(false),
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

    /// 暂停打标：当前这张打完后结束会话，归还显存。
    pub fn pause(&self) {
        self.shared.control().paused = true;
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
                self.session = None;
                self.shared.set(TaggingStatus::Paused);
                let c = self.shared.control();
                if c.paused && !c.stop {
                    drop(self.shared.wake.wait(c));
                }
                continue;
            }
            self.step();
        }
        self.session = None;
    }

    fn gpu_usable(&self) -> bool {
        self.gpu_failures < self.config.max_gpu_failures
    }

    /// 本机条件满足的第一个模型。
    fn choose(&mut self) -> Result<ModelSpec, String> {
        let info = self
            .device_info
            .get_or_insert_with(|| self.tagger.probe())
            .clone();
        let mut reasons = Vec::new();
        for spec in &self.config.models {
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
                self.session = None;
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
            self.session = None;
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
        self.session = None;
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
        self.session = None;
        self.shared.set(TaggingStatus::Failed { reason });
        self.shared.sleep(self.config.retry_delay);
    }

    /// 打一张图并写入。返回 `false` 表示这一批要中止（会话失效等）。
    fn tag_one(&mut self, model: &PreparedModel, source: &FactSource, id: &str) -> bool {
        let spec = &model.spec;
        let path = match self.library.original_path(id) {
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
            self.session = None;
            match self.tagger.start(model, spec.device) {
                Ok(session) => self.session = Some((spec.key.clone(), session)),
                Err(failure) => {
                    if spec.device == Device::DirectMl {
                        self.gpu_failures += 1;
                    }
                    self.fail(format!("无法开始打标：{failure}"));
                    return false;
                }
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
                self.crashes.remove(id);
                self.tagged += 1;
                let s = interpret(spec, &raw);
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
            Err(failure) => {
                // 会话已失效：结束它，稍后重启。
                self.session = None;
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
