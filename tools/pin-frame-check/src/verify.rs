//! 逐帧核对（桌面复制，DXGI Output Duplication）：DWM 每合成一帧取一次，只把钉图附近那一小块
//! 读回内存分析，不保存、不截整个桌面，报告只有数字。
//!
//! 钉 marker.png（品红边框宽度为短边的 5%）。每一帧里找品红的外框，它必须正好是某一次提交的
//! 内容矩形，且左边框的宽度要等于那一次提交的缩放所对应的宽度。WebView2 那种“新窗口位置配旧
//! 画面”的帧，外框位置对得上但边框宽度对不上，或外框对不上任何一次提交。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::*;
use windows::core::Interface;

use crate::rect::Rect;

#[derive(Debug, Clone, Copy)]
pub struct Submitted {
    /// 内容（不含阴影）在屏幕上的矩形。
    pub content: Rect,
    /// 窗口在屏幕上的矩形（只读回这附近）。
    pub window: Rect,
    /// 品红边框应有的宽度（物理像素，小数）。
    pub border: f64,
    /// 钉图半透明：品红混进背景，阈值认不出，这段时间的帧不核对。
    pub translucent: bool,
    /// 屏幕上应当看得见品红（外框有一部分在窗口与显示器里）。看不见品红而这一项为真，就是闪了一下。
    pub border_visible: bool,
    /// 外框位置与边框宽度额外放宽的像素。放大很多时边框内沿被插值抹开约一个源图像素，纯品红的
    /// 外框会比提交的窄（`--app` 的测试图小，放大到 5 倍以上）；自测用大图，为 0。
    pub slack: f64,
}

/// 核对结论。
pub struct Verdict {
    pub text: String,
    /// 对不上的帧：外框对不上任何一次提交、边框宽度不符、应看得见却没有品红、画面倒退。验收要求为 0。
    pub bad: u32,
    /// 核对了的帧数；为 0 说明桌面复制没取到帧（显示器休眠、锁屏），结论无效。
    pub checked: u32,
    /// 对上了某次提交的帧数；为 0 说明钉图根本没显示出来，结论同样无效。
    pub matched: u32,
}

pub struct Handle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Verdict>,
}

impl Handle {
    pub fn finish(self) -> Verdict {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.join().unwrap_or_else(|_| Verdict {
            text: "核对线程崩溃".into(),
            bad: 0,
            checked: 0,
            matched: 0,
        })
    }
}

pub fn start(log: Arc<Mutex<Vec<Submitted>>>, monitor: Rect) -> Handle {
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let thread = std::thread::spawn(move || match run(log, monitor, s) {
        Ok(r) => r,
        Err(e) => Verdict {
            text: format!("桌面复制不可用：{e}"),
            bad: 0,
            checked: 0,
            matched: 0,
        },
    });
    Handle { stop, thread }
}

fn run(
    log: Arc<Mutex<Vec<Submitted>>>,
    monitor: Rect,
    stop: Arc<AtomicBool>,
) -> windows::core::Result<Verdict> {
    unsafe {
        let mut device = None;
        let mut ctx = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            Default::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )?;
        let device: ID3D11Device = device.unwrap();
        let ctx: ID3D11DeviceContext = ctx.unwrap();
        let adapter = device.cast::<IDXGIDevice>()?.GetAdapter()?;
        let mut output = None;
        for i in 0.. {
            let Ok(o) = adapter.EnumOutputs(i) else { break };
            let d = o.GetDesc()?;
            if d.DesktopCoordinates.left == monitor.x && d.DesktopCoordinates.top == monitor.y {
                output = Some(o);
                break;
            }
        }
        let output: IDXGIOutput1 = output
            .ok_or_else(|| {
                windows::core::Error::new(windows::core::HRESULT(-1), "显示器不在这块显卡上")
            })?
            .cast()?;
        let dup = output.DuplicateOutput(&device)?;

        let mut frames = 0u32;
        let mut checked = 0u32;
        let mut matched = 0u32;
        let mut matched_clipped = 0u32;
        let mut translucent = 0u32;
        let mut wrong_border = 0u32;
        let mut unmatched = 0u32;
        let mut no_pin = 0u32;
        let mut flash = 0u32;
        let mut backwards = 0u32;
        let mut newest = 0usize;
        let mut accumulated_gt1 = 0u32;
        let mut examples = Vec::new();
        let mut staging: Option<(ID3D11Texture2D, i32, i32)> = None;
        // 哪些提交在屏幕上出现过（按提交序号）。
        let mut seen = std::collections::BTreeSet::new();

        while !stop.load(Ordering::SeqCst) {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res = None;
            match dup.AcquireNextFrame(50, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                Err(e) => return Err(e),
            }
            frames += 1;
            if info.AccumulatedFrames > 1 {
                accumulated_gt1 += 1;
            }
            // 只看画面有更新的帧（LastPresentTime 为 0 的只是指针动了）。
            if info.LastPresentTime == 0 {
                let _ = dup.ReleaseFrame();
                continue;
            }
            let submitted: Vec<Submitted> = log.lock().unwrap().clone();
            let Some(last) = submitted.last().copied() else {
                let _ = dup.ReleaseFrame();
                continue;
            };
            if last.translucent {
                translucent += 1;
                let _ = dup.ReleaseFrame();
                continue;
            }
            // 读回最近几次提交的窗口并集外扩 16 像素，夹在显示器里。
            let recent = &submitted[submitted.len().saturating_sub(6)..];
            let mut b = last.window;
            for s in recent {
                let x0 = b.x.min(s.window.x);
                let y0 = b.y.min(s.window.y);
                let x1 = b.right().max(s.window.right());
                let y1 = b.bottom().max(s.window.bottom());
                b = Rect {
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                };
            }
            let b = Rect {
                x: b.x - 16,
                y: b.y - 16,
                w: b.w + 32,
                h: b.h + 32,
            };
            let Some(region) = b.intersect(&monitor) else {
                let _ = dup.ReleaseFrame();
                continue;
            };
            let tex: ID3D11Texture2D = res.unwrap().cast()?;
            if staging
                .as_ref()
                .is_none_or(|(_, w, h)| *w < region.w || *h < region.h)
            {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: monitor.w as u32,
                    Height: monitor.h as u32,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut t = None;
                device.CreateTexture2D(&desc, None, Some(&mut t))?;
                staging = Some((t.unwrap(), monitor.w, monitor.h));
            }
            let st = &staging.as_ref().unwrap().0;
            let rx = (region.x - monitor.x) as u32;
            let ry = (region.y - monitor.y) as u32;
            let bx = D3D11_BOX {
                left: rx,
                top: ry,
                front: 0,
                right: rx + region.w as u32,
                bottom: ry + region.h as u32,
                back: 1,
            };
            ctx.CopySubresourceRegion(st, 0, 0, 0, 0, &tex, 0, Some(&bx));
            let _ = dup.ReleaseFrame();
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(st, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let pitch = mapped.RowPitch as usize;
            let data =
                std::slice::from_raw_parts(mapped.pData as *const u8, pitch * region.h as usize);
            // 只认几乎纯的品红：背景里别的程序的粉色、紫色不算（marker.png 的边框是纯 255,0,255）。
            let magenta = |x: i32, y: i32| {
                let p = y as usize * pitch + x as usize * 4;
                let (b, g, r) = (data[p], data[p + 1], data[p + 2]);
                r >= 250 && b >= 250 && g <= 6
            };
            // 品红外框。
            let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
            for y in 0..region.h {
                for x in 0..region.w {
                    if magenta(x, y) {
                        x0 = x0.min(x);
                        x1 = x1.max(x);
                        y0 = y0.min(y);
                        y1 = y1.max(y);
                    }
                }
            }
            checked += 1;
            if x0 == i32::MAX {
                no_pin += 1;
                // 最近两次提交都应看得见品红，画面里却没有：空帧（闪）。
                let n = submitted.len();
                if !seen.is_empty()
                    && submitted[n.saturating_sub(2)..]
                        .iter()
                        .all(|s| s.border_visible)
                {
                    flash += 1;
                    if examples.len() < 8 {
                        examples.push(format!("应看得见钉图却没有品红（第 {n} 次提交之后）"));
                    }
                }
                ctx.Unmap(st, 0);
                continue;
            }
            let found = Rect {
                x: region.x + x0,
                y: region.y + y0,
                w: x1 - x0 + 1,
                h: y1 - y0 + 1,
            };
            // 中间一行左边框的宽度，按“品红多过一半”量：缩得很小时三线性采样把边框内沿与绿色混在一起，
            // 只数纯品红会少算一两个像素（外框仍按纯品红认）。
            let mostly_magenta = |x: i32, y: i32| {
                let p = y as usize * pitch + x as usize * 4;
                let (b, g, r) = (
                    i32::from(data[p]),
                    i32::from(data[p + 1]),
                    i32::from(data[p + 2]),
                );
                (r + b) / 2 - g > 127
            };
            let mid = (y0 + y1) / 2;
            let mut run = 0;
            while x0 + run <= x1 && mostly_magenta(x0 + run, mid) {
                run += 1;
            }
            ctx.Unmap(st, 0);
            // 每次提交在屏幕上应有的品红外框：四条边框里看得见的部分（被屏幕或窗口裁过）的外框。
            // 放得比屏幕大时可能只剩一两条边框，外框就只是那几条。左边框完整可见时再量边框宽度。
            let hit = submitted.iter().enumerate().rev().find_map(|(k, s)| {
                let vis = s.content.intersect(&s.window)?.intersect(&monitor)?;
                let c = s.content;
                let bw = s.border.round().max(1.0) as i32;
                let strips = [
                    Rect::new(c.x, c.y, c.w, bw),
                    Rect::new(c.x, c.bottom() - bw, c.w, bw),
                    Rect::new(c.x, c.y, bw, c.h),
                    Rect::new(c.right() - bw, c.y, bw, c.h),
                ];
                let expect = strips
                    .iter()
                    .filter_map(|r| r.intersect(&vis))
                    .reduce(|a, b| a.union(&b))?;
                let near = |a: i32, b: i32| f64::from((a - b).abs()) <= 2.0 + s.slack;
                let ok = near(expect.x, found.x)
                    && near(expect.y, found.y)
                    && near(expect.right(), found.right())
                    && near(expect.bottom(), found.bottom());
                let whole = vis == c;
                ok.then_some((k, s, whole))
            });
            if let Some((k, _, _)) = hit {
                // 对上的提交比之前见过的旧好几次：旧画面又冒出来。
                if k + 3 < newest {
                    backwards += 1;
                    if examples.len() < 8 {
                        examples.push(format!(
                            "画面倒退：对上第 {k} 次提交，之前已见过第 {newest} 次"
                        ));
                    }
                }
                newest = newest.max(k);
            }
            match hit {
                Some((k, _, false)) => {
                    matched_clipped += 1;
                    seen.insert(k);
                }
                Some((k, s, true))
                    if (run as f64 - s.border).abs() <= 2.0 + s.slack + s.border * 0.03 =>
                {
                    matched += 1;
                    seen.insert(k);
                }
                Some((_, s, _)) => {
                    wrong_border += 1;
                    if examples.len() < 8 {
                        examples.push(format!(
                            "边框不符：外框 {found:?}，边框 {run} 像素，应为 {:.1}",
                            s.border
                        ));
                    }
                }
                None => {
                    unmatched += 1;
                    if examples.len() < 8 {
                        examples.push(format!("外框 {found:?} 对不上任何一次提交（最近一次 {:?}，第 {} 次提交，读回区域 {region:?}）", last.content, submitted.len()));
                    }
                }
            }
        }
        let total = log.lock().unwrap().len();
        let mut r = format!(
            "取到 {frames} 帧（{accumulated_gt1} 帧里合并了不止一次桌面更新），核对 {checked} 帧：\n\
             外框与边框都对上某次提交 {matched}，外框对上某次提交（被裁过、不量边框）{matched_clipped}，外框对上但边框宽度不符 {wrong_border}，外框对不上任何提交 {unmatched}，画面里没有品红 {no_pin}（其中应当看得见的 {flash}），画面倒退 {backwards}，半透明期间跳过 {translucent}\n\
             提交 {total} 次，其中在屏幕上被核对到的 {} 次",
            seen.len()
        );
        for e in examples {
            r.push_str("\n  ");
            r.push_str(&e);
        }
        Ok(Verdict {
            text: r,
            bad: wrong_border + unmatched + flash + backwards,
            checked,
            matched: matched + matched_clipped,
        })
    }
}
