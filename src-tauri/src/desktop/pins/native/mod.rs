//! 原生钉图（#277、ADR 0013）：每张钉图一个原生窗口，wgpu 绘制。#286 起是钉图唯一的实现（以前的
//! WebView 钉图层已删，见 ADR 0011、0013）。只在 Windows 上有；别的平台上钉图打不开。
//!
//! 线程：
//! - 界面线程（Tauri 主线程）：[`Orchestra`]、Windows 平台层（窗口消息、`translate`／`stage`／`swap`）。
//!   编排放在线程局部变量里，别的线程经 `run_on_main_thread` 投递；
//! - 渲染线程（[`RenderThread`]）：GPU 设备、上传、绘制；读图与颜色转换在读图线程上；
//! - 跑腿线程（[`courier`]）：提醒界面线程取输入、到时收尾手势，把编排的结果（保存、关闭、日志）
//!   交给应用。这些都可能要等锁，不放在界面线程上。
//!
//! 没有钉图时不建平台层和 GPU 设备；最后一张关掉后整个丢掉。

mod caption;
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

use std::collections::BTreeMap;
use std::sync::Mutex;

use kinshoko_core::desktop::ScreenRect;

use tauri::AppHandle;

use orchestra::Orchestra;
pub(super) use orchestra::{Frame, Look};
use render::RenderThread;

/// 一张原生钉图此刻的样子：F1 截图冻结时据此把选区映射回原图（界面线程每次用完编排后更新）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Seen {
    /// 内容此刻在屏幕上的位置。
    pub content: ScreenRect,
    /// 看得见的窗口（内容盖满显示器时让出了一行）。
    pub window: ScreenRect,
    /// 显示出来了，不在动画、手势中。
    pub still: bool,
    pub click_through: bool,
    /// 看得见的槽的窗口：查哪些窗口盖在它上面。
    pub hwnd: isize,
}

static SEEN: Mutex<BTreeMap<String, Seen>> = Mutex::new(BTreeMap::new());

/// 原生钉图此刻的样子；还没显示、已关时为 `None`。
pub(super) fn seen(pin: &str) -> Option<Seen> {
    crate::desktop::lock(&SEEN).get(pin).copied()
}

fn publish(seen: BTreeMap<String, Seen>) {
    *crate::desktop::lock(&SEEN) = seen;
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

/// 放到最上面（任意线程）。
#[cfg(windows)]
pub(super) fn raise(app: &AppHandle, pin: &str) {
    let pin = pin.to_owned();
    host::post_existing(app, move |o| o.raise(&pin));
}

#[cfg(not(windows))]
pub(super) fn raise(_: &AppHandle, _: &str) {}

/// 在钉图底部显示一条提示（菜单动作的结果，任意线程）。
#[cfg(windows)]
pub(super) fn notice(app: &AppHandle, pin: &str, text: &str) {
    let (pin, text) = (pin.to_owned(), text.to_owned());
    host::post_existing(app, move |o| {
        o.notice(&pin, text, std::time::Instant::now())
    });
}

#[cfg(not(windows))]
pub(super) fn notice(_: &AppHandle, _: &str, _: &str) {}

/// 别的平台上没有原生钉图：本次运行的记录收掉，状态留到下次启动。
#[cfg(not(windows))]
pub(super) fn open(app: &AppHandle, frame: Frame) {
    let (app, key) = (app.clone(), frame.pin.id);
    std::thread::spawn(move || super::closed(&app, &key));
}

#[cfg(not(windows))]
pub(super) fn frame(_: &AppHandle, _: Frame) {}

#[cfg(not(windows))]
pub(super) fn menu_closed(_: &AppHandle) {}

#[cfg(not(windows))]
pub(super) fn close(_: &AppHandle, _: &str) {}
