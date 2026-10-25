//! 界面线程上的编排：建在线程局部变量里，第一次要用时建平台层与渲染线程，钉图都关掉后整个丢掉。

use std::cell::RefCell;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Instant;

use kinshoko_core::desktop::frame::SourceSize;
use kinshoko_core::desktop::{PinContent, SavedPin};
use pin_shell::windows::WinShell;
use tauri::AppHandle;

use super::courier::{self, Job};
use super::orchestra::Submit;
use super::{Orchestra, RenderThread};
use crate::desktop::{lock, state};

pub(super) type Native = Orchestra<WinShell, RenderThread>;

thread_local! {
    static NATIVE: RefCell<Option<Native>> = const { RefCell::new(None) };
}

/// 逐帧核对（`tools/pin-frame-check --app`）读的提交记录：设了这个环境变量时每次提交追加一行。
const TRACE_ENV: &str = "KINSHOKO_PIN_TRACE";

/// 在界面线程上用编排做一件事（任意线程调用）。还没有编排时先建；建不起来或 `f` 出错时
/// 调 `failed`（在界面线程上，不要在里面等锁）。
pub fn post(
    app: &AppHandle,
    f: impl FnOnce(&mut Native) -> Result<(), String> + Send + 'static,
    failed: impl FnOnce(String) + Send + 'static,
) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = with(&handle, true, f) {
            failed(e);
        }
    }) {
        crate::run_log::error("原生钉图投递到界面线程失败", e);
    }
}

/// 只在已有编排时做（任意线程调用）。
pub fn post_existing(app: &AppHandle, f: impl FnOnce(&mut Native) + Send + 'static) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || with_existing(&handle, f));
}

/// 只在已有编排时做（平台层的输入、渲染层的回报、到时的收尾）。界面线程上调用。
pub fn with_existing(app: &AppHandle, f: impl FnOnce(&mut Native)) {
    let _ = with(app, false, |o| {
        f(o);
        Ok(())
    });
}

fn with(
    app: &AppHandle,
    create: bool,
    f: impl FnOnce(&mut Native) -> Result<(), String>,
) -> Result<(), String> {
    NATIVE.with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else {
            return Err("编排被重入".to_owned());
        };
        if slot.is_none() && create {
            *slot = Some(build(app).map_err(|e| format!("原生钉图建不起来：{e}"))?);
        }
        let Some(o) = slot.as_mut() else {
            return Ok(());
        };
        let result = f(o);
        super::publish(
            o.views(Instant::now())
                .into_iter()
                .filter_map(|v| {
                    let hwnd = o.platform().window_handle(v.id)?;
                    let seen = super::Seen {
                        content: v.content,
                        still: v.still,
                        click_through: v.click_through,
                        hwnd,
                    };
                    Some((v.key, seen))
                })
                .collect(),
        );
        for effect in o.take_effects() {
            courier::send(app, Job::Effect(effect));
        }
        courier::send(app, Job::Deadline(o.next_deadline()));
        if o.is_empty() {
            // 平台层（窗口、键盘钩子）与渲染线程（GPU 设备）都随之释放。
            *slot = None;
        }
        result
    })
}

fn build(app: &AppHandle) -> Result<Native, String> {
    let wake = app.clone();
    let shell =
        WinShell::new(move || courier::send(&wake, Job::Wake)).map_err(|e| e.to_string())?;
    let (reader, notifier) = (app.clone(), app.clone());
    let render = RenderThread::start(
        Arc::new(move |pin: &SavedPin, size| read_source(&reader, pin, size)),
        Arc::new(move |event| courier::send(&notifier, Job::Render(event))),
    );
    let mut o = Orchestra::new(shell, render);
    if let Some(path) = std::env::var_os(TRACE_ENV) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("打不开提交记录：{e}"))?;
        let started = Instant::now();
        o.on_submit(move |s: &Submit| {
            let (c, w) = (s.content, s.window);
            let _ = writeln!(
                file,
                "{:.3} {} {} {} {} {} {} {} {} {} {} {}",
                started.elapsed().as_secs_f64() * 1000.0,
                s.pin.0,
                c.x,
                c.y,
                c.width,
                c.height,
                w.x,
                w.y,
                w.width,
                w.height,
                s.scale,
                s.opacity
            );
        });
    }
    Ok(o)
}

/// 源图文件的字节：截图钉图读截图历史里的截图，资料库钉图经参考视角取派生图。读图线程上调用。
fn read_source(app: &AppHandle, pin: &SavedPin, size: SourceSize) -> Result<Vec<u8>, String> {
    let file = match &pin.content {
        PinContent::Capture { capture_id } => lock(&state(app).history).file(capture_id),
        PinContent::Reference { .. } => {
            let size = match size {
                SourceSize::Full => "full".to_owned(),
                SourceSize::Width(px) => format!("fit-{px}"),
            };
            super::super::reference_file(app, &pin.id, &size)
        }
    }
    .ok_or("找不到钉图的图")?;
    std::fs::read(&file).map_err(|e| format!("读不了 {}：{e}", file.display()))
}
