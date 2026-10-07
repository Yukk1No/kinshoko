//! 打标 port 的内存假实现：测试用它代替打标子进程（#42“测试策略”）。
//!
//! 按原图路径给出预设的原始结果，也能模拟子进程崩溃、显卡重置、坏图与慢速推理，
//! 并记录打过哪些图、当前有几个会话（会话占着显存）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::port::{
    Device, DeviceInfo, GpuInfo, PreparedModel, RawTag, SessionStopper, TagFailure, Tagger,
    TaggerSession,
};

#[derive(Default)]
struct State {
    gpu: Option<u64>,
    available_ram: u64,
    outputs: HashMap<PathBuf, Vec<RawTag>>,
    /// 原图 → 还要让会话崩溃几次。
    crashes: HashMap<PathBuf, u32>,
    /// 原图 → 还要报告几次显卡重置。
    device_lost: HashMap<PathBuf, u32>,
    bad: HashMap<PathBuf, String>,
    delay: Duration,
    tagged: Vec<(PathBuf, Device)>,
    started: Vec<(String, Device)>,
    live: usize,
}

/// 内存中的打标器。克隆共享同一份状态，测试保留一份用来布置与检查。
#[derive(Clone, Default)]
pub struct InMemoryTagger {
    state: Arc<Mutex<State>>,
}

impl InMemoryTagger {
    pub fn new() -> InMemoryTagger {
        InMemoryTagger::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 有独显时给出显存额度；`None` 表示没有独显。
    pub fn set_gpu(&self, vram_budget: Option<u64>) {
        self.lock().gpu = vram_budget;
    }

    pub fn set_available_ram(&self, bytes: u64) {
        self.lock().available_ram = bytes;
    }

    /// 对这张原图返回的原始结果。没有设置的图返回空结果。
    pub fn set_output(&self, image: &Path, tags: Vec<RawTag>) {
        self.lock().outputs.insert(image.to_path_buf(), tags);
    }

    /// 打这张图时让会话崩溃 `times` 次（之后正常）。
    pub fn crash_on(&self, image: &Path, times: u32) {
        self.lock().crashes.insert(image.to_path_buf(), times);
    }

    /// 打这张图时报告 `times` 次显卡重置。
    pub fn lose_device_on(&self, image: &Path, times: u32) {
        self.lock().device_lost.insert(image.to_path_buf(), times);
    }

    /// 这张图无法解码。
    pub fn bad_image(&self, image: &Path, reason: &str) {
        self.lock()
            .bad
            .insert(image.to_path_buf(), reason.to_owned());
    }

    /// 每张图推理要花的时间。
    pub fn set_delay(&self, delay: Duration) {
        self.lock().delay = delay;
    }

    /// 成功打过的图及所用设备，按先后顺序。
    pub fn tagged(&self) -> Vec<(PathBuf, Device)> {
        self.lock().tagged.clone()
    }

    /// 开始过的会话：模型 key 与设备。
    pub fn started(&self) -> Vec<(String, Device)> {
        self.lock().started.clone()
    }

    /// 当前还活着（占着显存）的会话数。
    pub fn live_sessions(&self) -> usize {
        self.lock().live
    }
}

impl Tagger for InMemoryTagger {
    fn probe(&self) -> DeviceInfo {
        let s = self.lock();
        DeviceInfo {
            gpu: s.gpu.map(|budget| GpuInfo {
                name: "测试显卡".into(),
                vram_budget: budget,
            }),
            available_ram: s.available_ram,
        }
    }

    fn start(
        &self,
        model: &PreparedModel,
        device: Device,
        on_stopper: &dyn Fn(SessionStopper),
    ) -> Result<Box<dyn TaggerSession>, TagFailure> {
        let dead: Arc<AtomicBool> = Arc::default();
        let flag = dead.clone();
        on_stopper(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        let mut s = self.lock();
        s.started.push((model.spec.key.clone(), device));
        s.live += 1;
        Ok(Box::new(Session {
            tagger: self.clone(),
            device,
            dead,
        }))
    }
}

struct Session {
    tagger: InMemoryTagger,
    device: Device,
    /// 会话已结束（崩溃或被 stopper 结束）。
    dead: Arc<AtomicBool>,
}

impl Session {
    fn ended(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }
}

impl TaggerSession for Session {
    fn tag(&mut self, image: &Path) -> Result<Vec<RawTag>, TagFailure> {
        let ended = || TagFailure::Crashed("会话已结束".into());
        if self.ended() {
            return Err(ended());
        }
        // 模拟推理耗时；会话被结束时立即返回，像子进程被结束一样。
        let until = Instant::now() + self.tagger.lock().delay;
        while Instant::now() < until {
            if self.ended() {
                return Err(ended());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let mut s = self.tagger.lock();
        if let Some(n) = s.crashes.get_mut(image).filter(|n| **n > 0) {
            *n -= 1;
            self.dead.store(true, Ordering::SeqCst);
            return Err(TagFailure::Crashed("模拟崩溃".into()));
        }
        if let Some(n) = s.device_lost.get_mut(image).filter(|n| **n > 0) {
            *n -= 1;
            self.dead.store(true, Ordering::SeqCst);
            return Err(TagFailure::DeviceLost("模拟显卡重置".into()));
        }
        if let Some(reason) = s.bad.get(image) {
            return Err(TagFailure::BadImage(reason.clone()));
        }
        s.tagged.push((image.to_path_buf(), self.device));
        Ok(s.outputs.get(image).cloned().unwrap_or_default())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.tagger.lock().live -= 1;
    }
}
