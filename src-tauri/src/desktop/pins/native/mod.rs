//! 原生钉图（#277、ADR 0013）：每张钉图一个原生窗口，wgpu 绘制。开发设置 `nativePins`（`settings.json`，
//! 界面上没有，重启生效）打开时取代钉图层；关着时这里什么都不做。#284 起与钉图层并存，#286 删掉钉图层。
//!
//! 线程：
//! - 界面线程（Tauri 主线程）：[`Orchestra`]、Windows 平台层（窗口消息、`translate`／`stage`／`swap`）。
//!   编排放在线程局部变量里，别的线程经 `run_on_main_thread` 投递；
//! - 渲染线程（[`RenderThread`]）：GPU 设备、上传、绘制；读图与颜色转换在读图线程上；
//! - 跑腿线程（[`courier`]）：提醒界面线程取输入、到时收尾手势，把编排的结果（保存、关闭、日志）
//!   交给应用。这些都可能要等锁，不放在界面线程上。
//!
//! 没有钉图时不建平台层和 GPU 设备；最后一张关掉后整个丢掉。

#[cfg(windows)]
mod courier;
mod draw;
#[cfg(windows)]
mod host;
#[cfg(all(test, windows))]
mod offscreen_tests;
mod orchestra;
mod port;
mod render;
mod surface;

use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use orchestra::Orchestra;
pub(super) use orchestra::{Frame, Look};
use render::RenderThread;

/// 本次运行是否用原生钉图（开发设置 `nativePins`，启动后第一次问时读一次）。
static ENABLED: OnceLock<bool> = OnceLock::new();

/// 要读应用壳设置：不要在主线程上第一次调用（[`super::restore`] 启动时已在别的线程上问过）。
/// 应用壳设置在桌面插件之后才装好，启动时等它一会儿，免得按“没设置”记下。
pub(super) fn enabled(app: &AppHandle) -> bool {
    *ENABLED.get_or_init(|| {
        if !cfg!(windows) {
            return false;
        }
        let started = std::time::Instant::now();
        loop {
            if let Some(shell) = app.try_state::<crate::shell::ShellState>() {
                return shell.0.lock().is_ok_and(|s| s.settings.native_pins());
            }
            if started.elapsed() > std::time::Duration::from_secs(10) {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    })
}

/// 打开一张钉图（任意线程）。打不开时写运行日志、收掉本次运行的钉图记录，状态留到下次启动。
#[cfg(windows)]
pub(super) fn open(app: &AppHandle, frame: Frame) {
    let (handle, key) = (app.clone(), frame.pin.id.clone());
    host::post(
        app,
        move |o| o.open(frame, std::time::Instant::now()),
        move |e| {
            crate::run_log::error("无法打开原生钉图", e);
            std::thread::spawn(move || super::closed(&handle, &key));
        },
    );
}

/// 关掉一张钉图的窗口（任意线程）。应用的关闭流程（`pins.json`、截图历史）由调用方做。
#[cfg(windows)]
pub(super) fn close(app: &AppHandle, pin: &str) {
    let pin = pin.to_owned();
    host::post_existing(app, move |o| o.close(&pin));
}

/// 应用壳改了钉图或它的外观（菜单动作、贴边隐藏、遮蔽、设置）：照着帧显示（任意线程）。
#[cfg(windows)]
pub(super) fn frame(app: &AppHandle, frame: Frame) {
    host::post_existing(app, move |o| o.frame(frame, std::time::Instant::now()));
}

/// 钉图菜单关掉了（或没打开）：键盘钩子恢复拦键（任意线程）。
#[cfg(windows)]
pub(super) fn menu_closed(app: &AppHandle) {
    host::post_existing(app, |o| o.menu_closed());
}

#[cfg(not(windows))]
pub(super) fn open(_: &AppHandle, _: Frame) {}

#[cfg(not(windows))]
pub(super) fn frame(_: &AppHandle, _: Frame) {}

#[cfg(not(windows))]
pub(super) fn menu_closed(_: &AppHandle) {}

#[cfg(not(windows))]
pub(super) fn close(_: &AppHandle, _: &str) {}
