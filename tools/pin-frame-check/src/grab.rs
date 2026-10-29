//! `--grab`：用桌面复制拍屏幕上的一块存成 PNG，给 `scripts/probe` 的探针核对像素。原生钉图是
//! DirectComposition 窗口，GDI 截屏（`ImageGrab`）拍不到，拍到的是它底下的东西。

use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::*;
use windows::core::Interface;

use crate::rect::Rect;

/// 拍 `region`（物理像素，要在一台显示器里）存到 `out`。
pub fn grab(region: Rect, out: &Path) -> Result<(), String> {
    let rgba = unsafe { read(region) }.map_err(|e| format!("桌面复制失败：{e}"))?;
    let bytes = crate::follow::png(region.w as u32, region.h as u32, &rgba);
    std::fs::write(out, bytes).map_err(|e| format!("写 {} 失败：{e}", out.display()))
}

unsafe fn read(region: Rect) -> windows::core::Result<Vec<u8>> {
    let failed = |m: &str| windows::core::Error::new(windows::core::HRESULT(-1), m);
    let mut device = None;
    let mut ctx = None;
    unsafe {
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
        // 包含这块区域的显示器。
        let mut found = None;
        for i in 0.. {
            let Ok(o) = adapter.EnumOutputs(i) else { break };
            let d = o.GetDesc()?.DesktopCoordinates;
            let m = Rect::new(d.left, d.top, d.right - d.left, d.bottom - d.top);
            if m.intersect(&region) == Some(region) {
                found = Some((o, m));
                break;
            }
        }
        let (output, monitor) = found.ok_or_else(|| failed("区域不在这块显卡的一台显示器里"))?;
        let dup = output.cast::<IDXGIOutput1>()?.DuplicateOutput(&device)?;
        // 第一帧就是整个桌面；之后的帧只在画面更新时才有，等不到也用第一帧。
        let deadline = Instant::now() + Duration::from_secs(2);
        let tex: ID3D11Texture2D = loop {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res = None;
            match dup.AcquireNextFrame(100, &mut info, &mut res) {
                Ok(()) if info.LastPresentTime != 0 || Instant::now() > deadline => {
                    break res.ok_or_else(|| failed("没有画面"))?.cast()?;
                }
                Ok(()) => {
                    let _ = dup.ReleaseFrame();
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT && Instant::now() < deadline => {}
                Err(e) => return Err(e),
            }
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: region.w as u32,
            Height: region.h as u32,
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
        let mut staging = None;
        device.CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.unwrap();
        let (rx, ry) = ((region.x - monitor.x) as u32, (region.y - monitor.y) as u32);
        let bx = D3D11_BOX {
            left: rx,
            top: ry,
            front: 0,
            right: rx + region.w as u32,
            bottom: ry + region.h as u32,
            back: 1,
        };
        ctx.CopySubresourceRegion(&staging, 0, 0, 0, 0, &tex, 0, Some(&bx));
        let _ = dup.ReleaseFrame();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let pitch = mapped.RowPitch as usize;
        let data = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * region.h as usize);
        let mut rgba = Vec::with_capacity(region.w as usize * region.h as usize * 4);
        for row in data.chunks_exact(pitch) {
            for bgra in row[..region.w as usize * 4].chunks_exact(4) {
                rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
            }
        }
        ctx.Unmap(&staging, 0);
        Ok(rgba)
    }
}
