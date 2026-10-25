//! 钉图状态与上屏：输入改 `View`，按 `geom::plan` 决定重画、挪窗或换窗，并登记给逐帧核对。

use super::*;
impl App {
    pub(crate) fn new(opts: Options) -> Result<App, String> {
        let gpu = gpu::Gpu::new()?;
        let shell = WinShell::new().map_err(|e| e.to_string())?;
        let (monitor, _) = sys::primary_monitor();
        let clip = if opts.full_screen_ok {
            monitor
        } else {
            // ADR 0011：不盖满整台显示器，让出最下面一行。
            Rect::new(monitor.x, monitor.y, monitor.w, monitor.h - 1)
        };
        Ok(App {
            gpu,
            shell,
            pins: Vec::new(),
            monitor,
            clip,
            opts,
            log: Arc::new(Mutex::new(Vec::new())),
            records: Vec::new(),
            phase: "",
            measure_gpu: false,
        })
    }

    pub(crate) fn add_pin(&mut self, path: &Path, k: usize) -> Result<(), String> {
        let img = image::open(path).map_err(|e| e.to_string())?.into_rgba8();
        let (w, h) = img.dimensions();
        let image = self.gpu.upload(w, h, img.as_raw());
        drop(img);
        // 等上传与 mip 做完，量内存时不把上传用的暂存缓冲算进去。
        self.gpu.wait_idle();
        let id = self.pins.len();
        let targets = self.shell.create(id);
        let [a, b] = targets;
        let surfaces = unsafe { [self.gpu.surface(a)?, self.gpu.surface(b)?] };
        let fit = (f64::from(self.monitor.h) * 0.6 / f64::from(h)).min(1.0);
        let scale = self.opts.scale.unwrap_or(fit);
        let view = View {
            src_w: w,
            src_h: h,
            x: f64::from(self.monitor.x + 60 + 40 * k as i32),
            y: f64::from(self.monitor.y + 60 + 30 * k as i32),
            scale,
            rotation: 0,
            flip_h: false,
            flip_v: false,
            opacity: 1.0,
        };
        self.pins.push(Pin {
            view,
            image,
            surfaces,
            window: Rect::default(),
            drawn: Rect::default(),
            gesture_until: None,
            drag: None,
            shown: false,
        });
        self.first_show(id)?;
        Ok(())
    }

    pub(crate) fn first_show(&mut self, id: usize) -> Result<(), String> {
        let p = &mut self.pins[id];
        let content = p.view.content();
        let Some(win) = needed(content, self.clip) else {
            return Ok(());
        };
        let slot = self.shell.visible_slot(id);
        self.gpu
            .draw(&mut p.surfaces[slot], &p.image, win, content, &p.view)?;
        self.shell.show(id, win);
        p.window = win;
        p.drawn = content;
        p.shown = true;
        // 第一帧也登记，核对时才认得出它。
        self.submit(id);
        Ok(())
    }

    pub(crate) fn border_visible(&self, content: Rect, window: Rect, view: &View) -> bool {
        let border = self.border(view);
        // 左、上边框那一条在屏幕上至少露出几个像素。
        let strip_l = Rect::new(content.x, content.y, border.ceil() as i32, content.h);
        let strip_t = Rect::new(content.x, content.y, content.w, border.ceil() as i32);
        let vis = |r: Rect| {
            r.intersect(&window)
                .and_then(|r| r.intersect(&self.monitor))
                .is_some_and(|r| r.w >= 3 && r.h >= 3)
        };
        view.opacity >= 1.0 && (vis(strip_l) || vis(strip_t))
    }

    pub(crate) fn border(&self, view: &View) -> f64 {
        f64::from(view.src_w.min(view.src_h) / 20) * view.scale
    }

    pub(crate) fn submit(&mut self, id: usize) {
        let p = &self.pins[id];
        let content = p.view.content();
        let s = verify::Submitted {
            content,
            window: p.window,
            border: self.border(&p.view),
            translucent: p.view.opacity < 1.0,
            border_visible: self.border_visible(content, p.window, &p.view),
        };
        self.log.lock().unwrap().push(s);
    }

    /// 钉图状态变了：按 [`plan`] 上屏。
    pub(crate) fn update(&mut self, id: usize, gesture: bool) -> Result<(), String> {
        let t0 = sys::qpc();
        let p = &mut self.pins[id];
        let content = p.view.content();
        let mut rec = Record {
            phase: self.phase,
            step: "",
            window_px: 0,
            total: 0.0,
            configure: 0.0,
            acquire: 0.0,
            submit: 0.0,
            wait: 0.0,
            gpu_done: 0.0,
        };
        if self.opts.naive {
            // 对照组：一个窗口，改尺寸与 Present 各管各的。
            let Some(win) = needed(content, self.clip) else {
                return Ok(());
            };
            let slot = self.shell.visible_slot(id);
            let hwnd = self.shell.hwnd(id, slot);
            let set = |r: Rect| unsafe {
                use windows::Win32::UI::WindowsAndMessaging::*;
                let _ = SetWindowPos(hwnd, None, r.x, r.y, r.w, r.h, SWP_NOACTIVATE | SWP_NOZORDER);
            };
            if !self.opts.present_first {
                set(win);
            }
            let t = self.gpu.draw(&mut p.surfaces[slot], &p.image, win, content, &p.view)?;
            self.shell.commit();
            if self.opts.present_first {
                set(win);
            }
            p.window = win;
            p.drawn = content;
            rec.step = "naive";
            rec.window_px = win.area();
            rec.configure = t.configure;
            rec.acquire = t.acquire;
            rec.submit = t.submit;
        } else {
            match plan(p.window, p.drawn, content, self.clip, gesture) {
                Step::Hidden => return Ok(()),
                Step::Redraw => {
                    let slot = self.shell.visible_slot(id);
                    let t = self.gpu.draw(&mut p.surfaces[slot], &p.image, p.window, content, &p.view)?;
                    rec.step = "redraw";
                    rec.configure = t.configure;
                    rec.acquire = t.acquire;
                    rec.submit = t.submit;
                }
                Step::Move(r) => {
                    self.shell.translate(id, r);
                    p.window = r;
                    rec.step = "move";
                }
                Step::Swap(r) => {
                    self.shell.stage(id, r);
                    let slot = 1 - self.shell.visible_slot(id);
                    let t = self.gpu.draw(&mut p.surfaces[slot], &p.image, r, content, &p.view)?;
                    rec.wait = self.shell.swap(id);
                    p.window = r;
                    rec.step = "swap";
                    rec.configure = t.configure;
                    rec.acquire = t.acquire;
                    rec.submit = t.submit;
                }
            }
            p.drawn = content;
            rec.window_px = p.window.area();
        }
        rec.total = sys::ms_since(t0);
        if self.measure_gpu {
            let t = sys::qpc();
            self.gpu.wait_idle();
            rec.gpu_done = sys::ms_since(t);
        }
        self.records.push(rec);
        self.submit(id);
        Ok(())
    }

    pub(crate) fn handle(&mut self, input: Input) -> Result<(), String> {
        match input {
            Input::Wheel { pin, x, y, notches } => {
                let p = &mut self.pins[pin];
                p.view.zoom_at(f64::from(x), f64::from(y), 1.1f64.powf(notches));
                p.gesture_until = Some(sys::qpc() + (SETTLE_MS * sys::qpf() as f64 / 1000.0) as i64);
                self.update(pin, true)?;
            }
            Input::Down { pin, x, y } => {
                let p = &mut self.pins[pin];
                p.drag = Some((x, y, p.view.x, p.view.y));
            }
            Input::Move { pin, x, y } => {
                let p = &mut self.pins[pin];
                if let Some((sx, sy, vx, vy)) = p.drag {
                    p.view.x = vx + f64::from(x - sx);
                    p.view.y = vy + f64::from(y - sy);
                    self.update(pin, true)?;
                }
            }
            Input::Up { pin, .. } => {
                if self.pins[pin].drag.take().is_some() {
                    self.update(pin, false)?;
                }
            }
            Input::Context { pin } => {
                self.shell.close(pin);
                self.pins[pin].shown = false;
            }
        }
        Ok(())
    }

    /// 一轮：处理消息与输入，到时的手势收尾。
    pub(crate) fn tick(&mut self) -> Result<(), String> {
        for i in self.shell.pump() {
            self.handle(i)?;
        }
        let now = sys::qpc();
        for id in 0..self.pins.len() {
            if self.pins[id].gesture_until.is_some_and(|t| now >= t) {
                self.pins[id].gesture_until = None;
                self.update(id, false)?;
            }
        }
        self.shell.housekeeping();
        Ok(())
    }

    pub(crate) fn pump_for(&mut self, ms: f64) -> Result<(), String> {
        let end = sys::qpc() + (ms * sys::qpf() as f64 / 1000.0) as i64;
        while sys::qpc() < end {
            self.tick()?;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Ok(())
    }
}

pub(crate) fn frame() {
    unsafe {
        let _ = DwmFlush();
    }
}
