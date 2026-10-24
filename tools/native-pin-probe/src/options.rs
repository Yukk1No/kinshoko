//! 命令行选项与 `--info`。

#![allow(unused_imports)]

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

use crate::measure::{self, ms, qpc};
use crate::raster::{Crop, PIN_EDGE, Quality, Rasterizer, Rect, View};
use crate::*;

pub(crate) struct Options {
    pub(crate) images: Vec<std::path::PathBuf>,
    pub(crate) count: usize,
    pub(crate) selftest: Option<std::path::PathBuf>,
    pub(crate) verify: bool,
    pub(crate) icc: bool,
    pub(crate) no_fullscreen: bool,
    pub(crate) menu_foreground: bool,
    pub(crate) hold_ms: Option<u64>,
    pub(crate) gesture_interp: bool,
    pub(crate) oversample: f64,
    pub(crate) threads: Option<usize>,
    pub(crate) dcomp: bool,
    pub(crate) move_first: bool,
    pub(crate) scale: Option<f64>,
    pub(crate) input_test: bool,
}

pub(crate) fn parse() -> Result<Options, String> {
    let mut o = Options {
        images: Vec::new(),
        count: 1,
        selftest: None,
        verify: false,
        icc: true,
        no_fullscreen: true,
        menu_foreground: false,
        hold_ms: None,
        gesture_interp: false,
        oversample: 2.0,
        threads: None,
        dcomp: false,
        move_first: false,
        scale: None,
        input_test: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--gen" => {
                let dir = args.next().ok_or("--gen 要目录")?;
                source::generate(std::path::Path::new(&dir))?;
                println!("测试图写到 {dir}");
                std::process::exit(0);
            }
            "--compare" => {
                let width: u32 = args
                    .next()
                    .ok_or("--compare 要宽度")?
                    .parse()
                    .map_err(|_| "--compare 要宽度")?;
                let path = args.next().ok_or("--compare 要图片")?;
                print!("{}", compare(width, std::path::Path::new(&path))?);
                std::process::exit(0);
            }
            "--info" => {
                info();
                std::process::exit(0);
            }
            "--count" => {
                o.count = args
                    .next()
                    .ok_or("--count 要数字")?
                    .parse()
                    .map_err(|_| "--count 要数字")?
            }
            "--selftest" => o.selftest = Some(args.next().ok_or("--selftest 要报告路径")?.into()),
            "--hold" => {
                o.hold_ms = Some(
                    args.next()
                        .ok_or("--hold 要毫秒")?
                        .parse()
                        .map_err(|_| "--hold 要毫秒")?,
                )
            }
            "--verify" => o.verify = true,
            "--backend" => match args.next().as_deref() {
                Some("ulw") => o.dcomp = false,
                Some("dcomp") => o.dcomp = true,
                _ => return Err("--backend ulw|dcomp".into()),
            },
            "--move-first" => o.move_first = true,
            "--input-test" => o.input_test = true,
            "--scale" => {
                o.scale = Some(
                    args.next()
                        .ok_or("--scale 要数字")?
                        .parse()
                        .map_err(|_| "--scale 要数字")?,
                )
            }
            "--gesture-interp" => o.gesture_interp = true,
            "--settle-from-full" => o.oversample = f64::INFINITY,
            "--threads" => {
                o.threads = Some(
                    args.next()
                        .ok_or("--threads 要数字")?
                        .parse()
                        .map_err(|_| "--threads 要数字")?,
                )
            }
            "--no-icc" => o.icc = false,
            "--full-screen-ok" => o.no_fullscreen = false,
            "--menu-foreground" => o.menu_foreground = true,
            s if s.starts_with("--") => return Err(format!("不认识的选项 {s}")),
            s => o.images.push(s.into()),
        }
    }
    if o.images.is_empty() {
        return Err("要一张图片路径".into());
    }
    Ok(o)
}

pub(crate) fn info() {
    for m in measure::monitors() {
        println!(
            "{} {:?} 工作区 {:?} DPI {} {} Hz 色彩模式 {} 配置文件 {:?}",
            m.device, m.rect, m.work, m.dpi, m.refresh_hz, m.colour_mode, m.icc
        );
    }
    println!("SHQueryUserNotificationState: {}", measure::quns());
    if let Some(t) = measure::dwm_timing() {
        println!(
            "DWM 刷新周期 {:.3} ms，已合成 {} 帧",
            ms(t.qpcRefreshPeriod as i64),
            { t.cFrame }
        );
    }
}
