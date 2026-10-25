//! 真正的渲染层：一个渲染线程持有 GPU 设备、各钉图的源图与 Surface、查找表；读图与颜色转换在
//! 另起的读图线程上，转好的像素交给渲染线程上传。没有钉图时不建设备，最后一张丢掉后释放。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use kinshoko_core::desktop::frame::SourceSize;
use kinshoko_core::desktop::pin_colour::{self, PinLut, PinPixels};
use kinshoko_core::desktop::{PinContent, SavedPin};
use pin_render::{Image, Lut, LutData, Pixels, Renderer, Surface};
use pin_shell::PinId;

use super::draw::draw_of;
use super::port::{DrawJob, RenderEvent, RenderPort};
use super::surface::{self, Target};

/// 读钉图源图文件的字节（截图历史里的截图，或经参考视角取的派生图）。
pub type ReadSource = dyn Fn(&SavedPin, SourceSize) -> Result<Vec<u8>, String> + Send + Sync;
/// 渲染层的回报，在渲染线程或读图线程上调用。
pub type Notify = dyn Fn(RenderEvent) + Send + Sync;

enum Msg {
    Attach(PinId, Result<[Target; 2], String>),
    /// 之后只收第 `seq` 次读的图。
    Want(PinId, u64),
    Upload {
        pin: PinId,
        seq: u64,
        size: SourceSize,
        pixels: PinPixels,
    },
    Draw(DrawJob),
    Detach(PinId),
}

/// [`RenderPort`] 的实现：方法只往渲染线程投消息。丢掉它时渲染线程随之退出、释放设备。
pub struct RenderThread {
    tx: Sender<Msg>,
    read: Arc<ReadSource>,
    notify: Arc<Notify>,
    seq: u64,
}

impl RenderThread {
    pub fn start(read: Arc<ReadSource>, notify: Arc<Notify>) -> RenderThread {
        let (tx, rx) = channel();
        let n = notify.clone();
        std::thread::Builder::new()
            .name("pin-render".into())
            .spawn(move || Worker::default().run(&rx, &*n))
            .expect("建渲染线程");
        RenderThread {
            tx,
            read,
            notify,
            seq: 0,
        }
    }
}

impl RenderPort for RenderThread {
    fn attach(&mut self, pin: PinId, targets: [wgpu::SurfaceTargetUnsafe; 2]) {
        let [a, b] = targets.each_ref().map(Target::of);
        let _ = self.tx.send(Msg::Attach(pin, a.and_then(|a| Ok([a, b?]))));
    }

    fn load(&mut self, pin: PinId, state: &SavedPin, size: SourceSize) {
        self.seq += 1;
        let seq = self.seq;
        let _ = self.tx.send(Msg::Want(pin, seq));
        let (tx, read, notify, state) = (
            self.tx.clone(),
            self.read.clone(),
            self.notify.clone(),
            state.clone(),
        );
        let spawned =
            std::thread::Builder::new()
                .name("pin-read".into())
                .spawn(
                    move || match read(&state, size).and_then(|bytes| decode(&state, &bytes)) {
                        Ok(pixels) => {
                            let _ = tx.send(Msg::Upload {
                                pin,
                                seq,
                                size,
                                pixels,
                            });
                        }
                        Err(reason) => notify(RenderEvent::LoadFailed { pin, reason }),
                    },
                );
        if let Err(e) = spawned {
            (self.notify)(RenderEvent::LoadFailed {
                pin,
                reason: e.to_string(),
            });
        }
    }

    fn draw(&mut self, job: DrawJob) {
        let _ = self.tx.send(Msg::Draw(job));
    }

    fn detach(&mut self, pin: PinId) {
        let _ = self.tx.send(Msg::Detach(pin));
    }
}

/// 截图按截图时显示器的配置文件展开；资料库的图按派生图管线的色彩规则转到线性工作空间。
fn decode(state: &SavedPin, bytes: &[u8]) -> Result<PinPixels, String> {
    match state.content {
        PinContent::Capture { .. } => pin_colour::screenshot(bytes),
        PinContent::Reference { .. } => pin_colour::derivative(bytes),
    }
}

#[derive(Default)]
struct Slot {
    surfaces: Option<[Surface; 2]>,
    image: Option<Image>,
    /// 源图的配置文件（查找表的源空间）。
    source: Option<Vec<u8>>,
    want: u64,
}

type LutKey = (Option<Vec<u8>>, Option<Arc<[u8]>>);

#[derive(Default)]
struct Worker {
    renderer: Option<Renderer>,
    pins: HashMap<PinId, Slot>,
    luts: HashMap<LutKey, Lut>,
}

impl Worker {
    fn run(mut self, rx: &Receiver<Msg>, notify: &Notify) {
        while let Ok(msg) = rx.recv() {
            match msg {
                Msg::Attach(pin, targets) => {
                    if let Err(reason) = self.attach(pin, targets) {
                        notify(RenderEvent::LoadFailed { pin, reason });
                    }
                }
                Msg::Want(pin, seq) => {
                    if let Some(p) = self.pins.get_mut(&pin) {
                        p.want = seq;
                    }
                }
                Msg::Upload {
                    pin,
                    seq,
                    size,
                    pixels,
                } => match self.upload(pin, seq, pixels) {
                    Ok(true) => notify(RenderEvent::Loaded { pin, size }),
                    Ok(false) => {}
                    Err(reason) => notify(RenderEvent::LoadFailed { pin, reason }),
                },
                Msg::Draw(job) => {
                    let pin = job.pin;
                    let result = self.draw(&job);
                    notify(RenderEvent::Drawn { pin, result });
                }
                Msg::Detach(pin) => {
                    self.pins.remove(&pin);
                    if self.pins.is_empty() {
                        // 先丢查找表，再丢设备。
                        self.luts.clear();
                        self.renderer = None;
                    }
                    notify(RenderEvent::Detached { pin });
                }
            }
        }
    }

    fn renderer(&mut self) -> Result<&Renderer, String> {
        if self.renderer.is_none() {
            self.renderer = Some(Renderer::new().map_err(|e| e.to_string())?);
        }
        Ok(self.renderer.as_ref().expect("刚建好"))
    }

    fn attach(&mut self, pin: PinId, targets: Result<[Target; 2], String>) -> Result<(), String> {
        // 先登记：建不起来也要等 Detach 才算完。
        let slot = self.pins.entry(pin).or_default();
        slot.surfaces = None;
        let renderer = self.renderer()?;
        let surfaces = surface::surfaces(renderer, targets?).map_err(|e| e.to_string())?;
        if let Some(slot) = self.pins.get_mut(&pin) {
            slot.surfaces = Some(surfaces);
        }
        Ok(())
    }

    /// 是最近一次要的图时上传，返回真。
    fn upload(&mut self, pin: PinId, seq: u64, pixels: PinPixels) -> Result<bool, String> {
        if self.pins.get(&pin).is_none_or(|p| p.want != seq) {
            return Ok(false);
        }
        let image = self
            .renderer()?
            .upload(Pixels {
                width: pixels.width,
                height: pixels.height,
                rgba: &pixels.rgba,
            })
            .map_err(|e| e.to_string())?;
        let slot = self.pins.get_mut(&pin).expect("上面查过");
        slot.image = Some(image);
        slot.source = pixels.source;
        Ok(true)
    }

    fn draw(&mut self, job: &DrawJob) -> Result<(), String> {
        let slot = self.pins.get(&job.pin).ok_or("钉图不在渲染层")?;
        let key = (slot.source.clone(), job.display.clone());
        if !self.luts.contains_key(&key) {
            let lut = pin_colour::lut(key.0.as_deref(), key.1.as_deref())?;
            let renderer = self.renderer()?;
            let lut = match &lut {
                PinLut::Identity => renderer.lut(LutData::Identity),
                PinLut::Table {
                    clut,
                    curve,
                    linear,
                } => renderer.lut(LutData::Table {
                    clut,
                    curve,
                    linear: *linear,
                }),
            }
            .map_err(|e| e.to_string())?;
            self.luts.insert(key.clone(), lut);
        }
        let renderer = self.renderer.as_ref().ok_or("没有 GPU 设备")?;
        let slot = self.pins.get_mut(&job.pin).ok_or("钉图不在渲染层")?;
        let image = slot.image.as_ref().ok_or("还没有图")?;
        let surface = slot
            .surfaces
            .as_mut()
            .ok_or("没有窗口画面")?
            .get_mut(job.slot)
            .ok_or("没有这个槽")?;
        let draw = draw_of(job, (image.width(), image.height()));
        renderer
            .draw(surface, image, &draw, &self.luts[&key])
            .map_err(|e| e.to_string())
    }
}
