//! 真正的渲染层：一个渲染线程持有 GPU 设备、各钉图的源图与 Surface、查找表；读图与颜色转换在
//! 另起的读图线程上，转好的像素交给渲染线程上传。没有钉图时不建设备，最后一张丢掉后释放。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use kinshoko_core::desktop::frame::SourceSize;
use kinshoko_core::desktop::pin_colour::{self, PinLut, PinPixels};
use kinshoko_core::desktop::{PinContent, SavedPin};
use pin_render::{Image, Lut, LutData, Overlay, Pixels, Renderer, Surface};
use pin_shell::PinId;

use super::caption::{Caption, Painter};
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
    /// 第 `seq` 次读图失败。经渲染线程转交，只报给还认得这张钉图的那一个编排：上一个编排留下的
    /// 读图线程拿着旧渲染线程的发送端，钉图编号又会从头用起。
    ReadFailed {
        pin: PinId,
        seq: u64,
        reason: String,
    },
    Draw(Box<DrawJob>),
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
        let (tx, read, state) = (self.tx.clone(), self.read.clone(), state.clone());
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
                        Err(reason) => {
                            let _ = tx.send(Msg::ReadFailed { pin, seq, reason });
                        }
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
        let _ = self.tx.send(Msg::Draw(Box::new(job)));
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
    /// 上一次画的说明层：画它时的说明、内容尺寸、缩放比例（千分之一）与主题。
    caption: Option<(CaptionKey, Overlay, (i32, i32))>,
}

type CaptionKey = (Caption, (u32, u32), u32, bool);

/// 读不到图时的占位：中性灰（沿用以前钉图层的 #8d8d8d）。
const PLACEHOLDER: [u8; 4] = [0x8d, 0x8d, 0x8d, 255];

type LutKey = (Option<Vec<u8>>, Option<Arc<[u8]>>);

#[derive(Default)]
struct Worker {
    renderer: Option<Renderer>,
    pins: HashMap<PinId, Slot>,
    luts: HashMap<LutKey, Lut>,
    painter: Painter,
    /// 占位的 1×1 灰图（第一次要时上传）。
    placeholder: Option<Image>,
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
                Msg::ReadFailed { pin, seq, reason } => {
                    if self.pins.get(&pin).is_some_and(|p| p.want == seq) {
                        notify(RenderEvent::LoadFailed { pin, reason });
                    }
                }
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
                        self.placeholder = None;
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
        // 占位不用源图，也就没有源图的配置文件：按 sRGB。
        let source = if job.placeholder {
            None
        } else {
            slot.source.clone()
        };
        let key = (source.clone(), job.display.clone());
        self.ensure_lut(&key)?;
        // 界面颜色（遮蔽墨色、细线、提示框、说明层）是 sRGB；截图钉图的源空间是截图时的显示器，另要一张。
        let ui_key = (None, job.display.clone());
        if source.is_some() {
            self.ensure_lut(&ui_key)?;
        }
        if job.placeholder && self.placeholder.is_none() {
            let png = encode_png(PLACEHOLDER)?;
            let pixels = pin_colour::derivative(&png)?;
            let image = self
                .renderer()?
                .upload(Pixels {
                    width: pixels.width,
                    height: pixels.height,
                    rgba: &pixels.rgba,
                })
                .map_err(|e| e.to_string())?;
            self.placeholder = Some(image);
        }
        self.paint_caption(job)?;
        let renderer = self.renderer.as_ref().ok_or("没有 GPU 设备")?;
        let slot = self.pins.get_mut(&job.pin).ok_or("钉图不在渲染层")?;
        let image = if job.placeholder {
            self.placeholder.as_ref().ok_or("没有占位图")?
        } else {
            slot.image.as_ref().ok_or("还没有图")?
        };
        let overlay = slot.caption.as_ref().map(|(_, o, at)| (o, *at));
        let surface = slot
            .surfaces
            .as_mut()
            .ok_or("没有窗口画面")?
            .get_mut(job.slot)
            .ok_or("没有这个槽")?;
        let mut draw = draw_of(job, (image.width(), image.height()), overlay);
        if source.is_some() {
            draw.ui_lut = Some(&self.luts[&ui_key]);
        }
        renderer
            .draw(surface, image, &draw, &self.luts[&key])
            .map_err(|e| e.to_string())
    }

    fn ensure_lut(&mut self, key: &LutKey) -> Result<(), String> {
        if self.luts.contains_key(key) {
            return Ok(());
        }
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
        Ok(())
    }

    /// 说明层变了（或内容尺寸变了）才重画、重新上传。
    fn paint_caption(&mut self, job: &DrawJob) -> Result<(), String> {
        let size = (job.content.width, job.content.height);
        let key: CaptionKey = (
            job.caption.clone(),
            size,
            (job.display_scale * 1000.0).round() as u32,
            job.dark,
        );
        let slot = self.pins.get(&job.pin).ok_or("钉图不在渲染层")?;
        if slot.caption.as_ref().map(|(k, ..)| k) == Some(&key)
            || (job.caption.is_empty() && slot.caption.is_none())
        {
            return Ok(());
        }
        let painted = self
            .painter
            .paint(&job.caption, size, job.display_scale, job.dark);
        let overlay = match painted {
            Some(p) => {
                let o = self
                    .renderer()?
                    .overlay(p.width, p.height, &p.rgba)
                    .map_err(|e| e.to_string())?;
                Some((key, o, p.at))
            }
            None => None,
        };
        if let Some(slot) = self.pins.get_mut(&job.pin) {
            slot.caption = overlay;
        }
        Ok(())
    }
}

/// 一个像素的 PNG（占位图走与派生图相同的颜色管线）。
fn encode_png(rgba: [u8; 4]) -> Result<Vec<u8>, String> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_raw(1, 1, rgba.to_vec())
        .ok_or("占位图")?
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn only_the_latest_read_of_a_pin_this_thread_knows_is_reported_failed() {
        let mut worker = Worker::default();
        worker.pins.insert(
            PinId(1),
            Slot {
                want: 2,
                ..Slot::default()
            },
        );
        let (tx, rx) = channel();
        for (pin, seq) in [(1, 1), (7, 2), (1, 2)] {
            tx.send(Msg::ReadFailed {
                pin: PinId(pin),
                seq,
                reason: format!("{pin}/{seq}"),
            })
            .unwrap();
        }
        drop(tx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        worker.run(&rx, &move |e| log.lock().unwrap().push(e));
        assert_eq!(
            *seen.lock().unwrap(),
            [RenderEvent::LoadFailed {
                pin: PinId(1),
                reason: "1/2".into()
            }]
        );
    }
}
