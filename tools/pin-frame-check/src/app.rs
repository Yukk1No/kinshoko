//! 一个最小的编排：输入改 `SavedPin`，按 `frame::plan` 决定重画、平移或换窗，经 pin-shell 上屏、
//! pin-render 画，并把每次提交登记给逐帧核对。换窗还没完成时再来的更新先记下，`Swapped` 之后补上
//! （不往快要换下的槽里画，画面不会倒退）——这也是给 #284 编排的建议做法。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kinshoko_core::desktop::frame::{
    Step, ZoomAnchor, drawing, plan, source_rect, wheel_opacity, wheel_zoom_scale, window_for,
};
use kinshoko_core::desktop::{PIN_EDGE, PinContent, Placement, SavedPin, ScreenRect};
use pin_render::{Draw, Image, Lut, LutData, Pixels, Renderer, Surface, Turn, Window};
use pin_shell::windows::WinShell;
use pin_shell::{PinId, PinInput, PinShell, PointerEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
};

use crate::rect::Rect;
use crate::verify::Submitted;

/// 停手多久算手势结束（与 ADR 0005、#281 的 120 ms 相同）。
pub const SETTLE_MS: u64 = 120;
/// 测试图：品红边框（短边的 5%），里面绿色棋盘。
pub const MARKER: (u32, u32) = (2000, 3000);

#[derive(Default, Clone)]
pub struct Options {
    pub selftest: Option<std::path::PathBuf>,
    pub verify: bool,
    /// 对照组：只用一个槽，每帧改尺寸再 Present（或反过来）。
    pub naive: bool,
    pub present_first: bool,
    pub count: usize,
    pub hold_ms: Option<u64>,
    pub fill: bool,
    pub input_test: bool,
    pub region_test: bool,
    pub scale: Option<f64>,
}

/// 一次上屏的耗时（毫秒）。
pub struct Record {
    pub phase: &'static str,
    pub step: &'static str,
    pub window_px: i64,
    pub total: f64,
}

pub struct TestPin {
    pub id: PinId,
    pub pin: SavedPin,
    image: Image,
    /// 设备丢失重建时先丢掉旧的，再建新的。
    surfaces: Option<[Surface; 2]>,
    /// 看得见的槽的窗口，与上次画进它的内容。
    pub window: ScreenRect,
    drawn: ScreenRect,
    /// 摆好、画好、等换上的备用槽（窗口，内容）。
    staged: Option<(ScreenRect, ScreenRect)>,
    /// 等换上期间来的更新（是否手势中）。
    dirty: Option<bool>,
    gesture_until: Option<Instant>,
    anchor: Option<((i32, i32), ZoomAnchor)>,
    drag: Option<((i32, i32), (i32, i32))>,
}

pub struct App {
    pub render: Renderer,
    pub lut: Lut,
    pub shell: WinShell,
    pub pins: Vec<TestPin>,
    pub monitor: ScreenRect,
    monitors: Vec<ScreenRect>,
    pub opts: Options,
    pub log: Arc<Mutex<Vec<Submitted>>>,
    pub records: Vec<Record>,
    pub phase: &'static str,
    /// 每条窗口消息的处理时间（毫秒）。
    pub dispatch_ms: Vec<f64>,
    /// 每次调 `swap` 本身花的时间、从 `swap` 到 `Swapped` 的时间（毫秒）。
    pub swap_call_ms: Vec<f64>,
    pub swap_wait_ms: Vec<f64>,
    pub keys: Vec<PinInput>,
}

fn f16(v: f32) -> u16 {
    // 0～1 的正规数够用（测试图只有这几种颜色）。
    if v <= 0.0 {
        return 0;
    }
    let bits = v.to_bits();
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = (bits >> 13) & 0x3ff;
    ((exp.clamp(0, 31) as u32) << 10 | mant) as u16
}

/// 测试图的像素：线性、预乘 alpha 的 f16（不透明，预乘不改值）。
fn marker() -> Vec<u16> {
    let (w, h) = MARKER;
    let border = w.min(h) / 20;
    let magenta = [f16(1.0), 0, f16(1.0), f16(1.0)];
    // sRGB (30,160,60) 与 (200,230,200) 的线性值。
    let dark = [f16(0.0123), f16(0.3515), f16(0.0452), f16(1.0)];
    let light = [f16(0.578), f16(0.791), f16(0.578), f16(1.0)];
    let mut px = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h {
        for x in 0..w {
            let c = if x < border || y < border || x >= w - border || y >= h - border {
                magenta
            } else if ((x / 125) + (y / 125)) % 2 == 0 {
                dark
            } else {
                light
            };
            px.extend_from_slice(&c);
        }
    }
    px
}

impl App {
    pub fn new(opts: Options) -> Result<App, String> {
        let render = Renderer::new().map_err(|e| e.to_string())?;
        let lut = render.lut(LutData::Identity).map_err(|e| e.to_string())?;
        let shell = WinShell::new(|| {}).map_err(|e| e.to_string())?;
        let displays = shell.displays();
        let monitor = displays
            .iter()
            .find(|d| d.rect.x == 0 && d.rect.y == 0)
            .or(displays.first())
            .ok_or("没有显示器")?
            .rect;
        Ok(App {
            render,
            lut,
            shell,
            pins: Vec::new(),
            monitor,
            monitors: displays.iter().map(|d| d.rect).collect(),
            opts,
            log: Arc::new(Mutex::new(Vec::new())),
            records: Vec::new(),
            phase: "",
            dispatch_ms: Vec::new(),
            swap_call_ms: Vec::new(),
            swap_wait_ms: Vec::new(),
            keys: Vec::new(),
        })
    }

    pub fn add_pin(&mut self, k: usize) -> Result<(), String> {
        let (w, h) = MARKER;
        let px = marker();
        let image = self
            .render
            .upload(Pixels {
                width: w,
                height: h,
                rgba: &px,
            })
            .map_err(|e| e.to_string())?;
        drop(px);
        self.render.wait_idle();
        let id = PinId(self.pins.len() as u64 + 1);
        let [a, b] = self.shell.create(id).map_err(|e| e.to_string())?;
        // SAFETY：两个目标在钉图关掉之前有效；Surface 随 TestPin 一起丢掉。
        let surfaces = unsafe {
            [
                self.render.surface(a).map_err(|e| e.to_string())?,
                self.render.surface(b).map_err(|e| e.to_string())?,
            ]
        };
        let fit = f64::from(self.monitor.height) * 0.6 / f64::from(h);
        let pin = SavedPin {
            id: format!("test-{}", id.0),
            content: PinContent::Reference {
                library_id: "test".into(),
                image_id: "marker".into(),
                source_width: w,
                source_height: h,
            },
            crop: None,
            width: w,
            height: h,
            placement: Placement {
                x: self.monitor.x + 60 + 40 * k as i32,
                y: self.monitor.y + 60 + 30 * k as i32,
                scale: self.opts.scale.unwrap_or(fit.min(1.0)),
                ..Placement::default()
            },
            opacity: 1.0,
            locked: false,
            member: None,
        };
        self.pins.push(TestPin {
            id,
            pin,
            image,
            surfaces: Some(surfaces),
            window: ScreenRect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            drawn: ScreenRect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            staged: None,
            dirty: None,
            gesture_until: None,
            anchor: None,
            drag: None,
        });
        self.first_show(self.pins.len() - 1)
    }

    pub fn index(&self, id: PinId) -> Option<usize> {
        self.pins.iter().position(|p| p.id == id)
    }

    fn draw(&mut self, i: usize, slot: usize, window: ScreenRect) -> Result<(), String> {
        draw_pin(&self.render, &self.lut, &mut self.pins[i], slot, window)
    }

    /// 往看得见的槽重画一帧（不改窗口）。
    pub fn redraw_visible(&mut self, i: usize) -> Result<(), String> {
        let slot = self.shell.visible_slot(self.pins[i].id);
        let win = self.pins[i].window;
        self.draw(i, slot, win)
    }

    /// 渲染层重建后重新上传测试图。
    pub fn reupload(&mut self, i: usize) -> Result<(), String> {
        let (w, h) = MARKER;
        let px = marker();
        self.pins[i].image = self
            .render
            .upload(Pixels {
                width: w,
                height: h,
                rgba: &px,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn drop_surfaces(&mut self, i: usize) {
        self.pins[i].surfaces = None;
    }

    pub fn set_surfaces(&mut self, i: usize, surfaces: [Surface; 2]) {
        self.pins[i].surfaces = Some(surfaces);
    }

    fn first_show(&mut self, i: usize) -> Result<(), String> {
        let content = self.pins[i].pin.rect();
        let Some(win) = window_for(content, &self.monitors) else {
            return Ok(());
        };
        let slot = self.shell.visible_slot(self.pins[i].id);
        self.draw(i, slot, win)?;
        self.shell.show(self.pins[i].id, win);
        let p = &mut self.pins[i];
        p.window = win;
        p.drawn = content;
        self.submit(content, win, i);
        Ok(())
    }

    pub fn border(&self, i: usize) -> f64 {
        f64::from(MARKER.0.min(MARKER.1) / 20) * self.pins[i].pin.placement.scale
    }

    fn submit(&mut self, content: ScreenRect, window: ScreenRect, i: usize) {
        let border = self.border(i);
        let (c, w, m) = (
            Rect::from(content),
            Rect::from(window),
            Rect::from(self.monitor),
        );
        let visible = |r: Rect| {
            r.intersect(&w)
                .and_then(|r| r.intersect(&m))
                .is_some_and(|r| r.w >= 3 && r.h >= 3)
        };
        let b = border.ceil() as i32;
        let opaque = self.pins[i].pin.opacity >= 1.0;
        self.log.lock().unwrap().push(Submitted {
            content: c,
            window: w,
            border,
            translucent: !opaque,
            border_visible: opaque
                && (visible(Rect::new(c.x, c.y, b, c.h)) || visible(Rect::new(c.x, c.y, c.w, b))),
            slack: 0.0,
        });
    }

    /// 钉图状态变了：按 `plan` 上屏。换窗还没完成时先记下，换上之后再来。
    pub fn update(&mut self, i: usize, gesture: bool) -> Result<(), String> {
        let t0 = Instant::now();
        if self.pins[i].staged.is_some() {
            let p = &mut self.pins[i];
            p.dirty = Some(p.dirty.unwrap_or(false) || gesture);
            return Ok(());
        }
        let id = self.pins[i].id;
        let content = self.pins[i].pin.rect();
        let step = if self.opts.naive {
            let Some(win) = window_for(content, &self.monitors) else {
                return Ok(());
            };
            self.naive(i, win)?;
            "naive"
        } else {
            let p = &self.pins[i];
            match plan(p.window, p.drawn, content, &self.monitors, gesture) {
                Step::Hidden => return Ok(()),
                Step::Redraw => {
                    let (slot, win) = (self.shell.visible_slot(id), p.window);
                    self.draw(i, slot, win)?;
                    "redraw"
                }
                Step::Move(r) => {
                    self.shell.translate(id, r);
                    self.pins[i].window = r;
                    "move"
                }
                Step::Swap(r) => {
                    self.shell.stage(id, r);
                    let standby = 1 - self.shell.visible_slot(id);
                    self.draw(i, standby, r)?;
                    let t = Instant::now();
                    self.shell.swap(id);
                    self.swap_call_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                    self.pins[i].staged = Some((r, content));
                    self.submit(content, r, i);
                    self.record("swap", r, t0);
                    return Ok(());
                }
            }
        };
        let win = self.pins[i].window;
        self.pins[i].drawn = content;
        self.submit(content, win, i);
        self.record(step, win, t0);
        Ok(())
    }

    fn naive(&mut self, i: usize, win: ScreenRect) -> Result<(), String> {
        let id = self.pins[i].id;
        let slot = self.shell.visible_slot(id);
        let App {
            shell,
            render,
            pins,
            lut,
            opts,
            ..
        } = self;
        let mut result = Ok(());
        shell.control_group(id, win, opts.present_first, || {
            result = draw_pin(render, lut, &mut pins[i], slot, win);
        });
        self.pins[i].window = win;
        result
    }

    fn record(&mut self, step: &'static str, win: ScreenRect, t0: Instant) {
        self.records.push(Record {
            phase: self.phase,
            step,
            window_px: i64::from(win.width) * i64::from(win.height),
            total: t0.elapsed().as_secs_f64() * 1000.0,
        });
    }

    fn swapped(&mut self, id: PinId, waited_ms: f64) -> Result<(), String> {
        self.swap_wait_ms.push(waited_ms);
        let Some(i) = self.index(id) else {
            return Ok(());
        };
        let p = &mut self.pins[i];
        if let Some((win, content)) = p.staged.take() {
            p.window = win;
            p.drawn = content;
        }
        if let Some(gesture) = p.dirty.take() {
            self.update(i, gesture)?;
        }
        Ok(())
    }

    fn gesture(&mut self, i: usize) {
        self.pins[i].gesture_until = Some(Instant::now() + Duration::from_millis(SETTLE_MS));
    }

    pub fn handle(&mut self, input: PinInput) -> Result<(), String> {
        match input {
            PinInput::Swapped { pin, waited_ms } => self.swapped(pin, waited_ms)?,
            PinInput::Wheel {
                pin,
                at,
                notches,
                ctrl,
            } => {
                let Some(i) = self.index(pin) else {
                    return Ok(());
                };
                let p = &mut self.pins[i];
                if ctrl {
                    let o = wheel_opacity(p.pin.opacity, -notches * 100.0);
                    p.pin.set_opacity(o);
                } else {
                    let anchor = match p.anchor {
                        Some((a, z)) if a == at => z,
                        _ => ZoomAnchor::new(&p.pin, (f64::from(at.0), f64::from(at.1))),
                    };
                    p.anchor = Some((at, anchor));
                    let scale = wheel_zoom_scale(p.pin.placement.scale, -notches * 100.0);
                    anchor.zoom(&mut p.pin, scale);
                }
                self.gesture(i);
                self.update(i, true)?;
            }
            PinInput::Pointer(e) => {
                let Some(i) = self.index(e.pin) else {
                    return Ok(());
                };
                self.pointer(i, e.at, e.event)?;
            }
            PinInput::Key { .. } => self.keys.push(input),
            _ => {}
        }
        Ok(())
    }

    /// 按着拖动移动（不分鼠标、笔、触摸）。
    pub fn pointer(&mut self, i: usize, at: (i32, i32), event: PointerEvent) -> Result<(), String> {
        let p = &mut self.pins[i];
        match event {
            PointerEvent::Down(_) => {
                p.drag = Some((at, (p.pin.placement.x, p.pin.placement.y)));
                self.shell.raise(p.id);
            }
            PointerEvent::Move => {
                if let Some((start, origin)) = p.drag {
                    p.pin
                        .move_to(origin.0 + at.0 - start.0, origin.1 + at.1 - start.1);
                    self.gesture(i);
                    self.update(i, true)?;
                }
            }
            PointerEvent::Up(_) | PointerEvent::Cancel => {
                if p.drag.take().is_some() {
                    self.update(i, false)?;
                }
            }
            PointerEvent::Leave => {}
        }
        Ok(())
    }

    /// 一轮：分发窗口消息（量每条的处理时间）、处理输入、到时的手势收尾。
    pub fn tick(&mut self) -> Result<(), String> {
        let mut msg = MSG::default();
        // SAFETY：`msg` 由本函数持有；分发本线程的消息。
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let t = Instant::now();
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                self.dispatch_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            }
        }
        for input in self.shell.pump() {
            self.handle(input)?;
        }
        let now = Instant::now();
        for i in 0..self.pins.len() {
            if self.pins[i].gesture_until.is_some_and(|t| now >= t) {
                self.pins[i].gesture_until = None;
                self.update(i, false)?;
            }
        }
        Ok(())
    }

    pub fn pump_for(&mut self, ms: u64) -> Result<(), String> {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            self.tick()?;
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }

    /// 换窗都完成、手势都收尾。
    pub fn settle(&mut self) -> Result<(), String> {
        self.pump_for(SETTLE_MS + 80)?;
        let end = Instant::now() + Duration::from_secs(1);
        while self.pins.iter().any(|p| p.staged.is_some()) && Instant::now() < end {
            self.tick()?;
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }
}

fn draw_pin(
    render: &Renderer,
    lut: &Lut,
    p: &mut TestPin,
    slot: usize,
    window: ScreenRect,
) -> Result<(), String> {
    let d = drawing(&p.pin);
    let c = p.pin.rect();
    let src = source_rect(&p.pin, MARKER.0, MARKER.1);
    let draw = Draw {
        turn: Turn {
            quarter: d.quarter_turns,
            flip_h: d.flip_h,
            flip_v: d.flip_v,
        },
        opacity: p.pin.opacity as f32,
        edge: PIN_EDGE as f32,
        ..Draw::new(
            Window {
                x: window.x,
                y: window.y,
                width: window.width,
                height: window.height,
            },
            pin_render::Rect::new(c.x as f32, c.y as f32, c.width as f32, c.height as f32),
            pin_render::Rect::new(
                src.x as f32,
                src.y as f32,
                src.width as f32,
                src.height as f32,
            ),
        )
    };
    render
        .draw(
            &mut p.surfaces.as_mut().ok_or("没有 Surface")?[slot],
            &p.image,
            &draw,
            lut,
        )
        .map_err(|e| e.to_string())
}
