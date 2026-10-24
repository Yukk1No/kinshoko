//! 对照组：DirectComposition ＋ Direct2D 交换链（`--backend dcomp`）。
//!
//! 源图第 0 层整张上传成 GPU 位图，每帧由 Direct2D 用高质量三次插值画到窗口大小的交换链上，
//! 再用 SetWindowPos 改窗口、DComp Commit。CPU 几乎不碰像素；要回答的是窗口几何（SetWindowPos）
//! 与交换链内容（Present／Commit）能不能在同一帧到位。阴影这里只画一圈近似的半透明黑边。

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::DirectComposition::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::core::Interface;
use windows_numerics::Matrix3x2;

use crate::raster::{PIN_EDGE, Rect, View};
use crate::source::Source;

pub struct Gpu {
    d3d: ID3D11Device,
    factory: IDXGIFactory2,
    d2d: ID2D1Device,
    dcomp: IDCompositionDevice,
    adapter: IDXGIAdapter3,
}

pub struct GpuPin {
    swap: IDXGISwapChain1,
    dc: ID2D1DeviceContext,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    bitmap: ID2D1Bitmap1,
    size: (u32, u32),
    shadow: ID2D1SolidColorBrush,
}

impl Gpu {
    pub fn new() -> windows::core::Result<Gpu> {
        unsafe {
            let mut d3d = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                None,
            )?;
            let d3d: ID3D11Device = d3d.unwrap();
            let dxgi: IDXGIDevice = d3d.cast()?;
            let adapter: IDXGIAdapter3 = dxgi.GetAdapter()?.cast()?;
            let factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;
            let d2d_factory: ID2D1Factory1 =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let d2d = d2d_factory.CreateDevice(&dxgi)?;
            let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
            Ok(Gpu {
                d3d,
                factory,
                d2d,
                dcomp,
                adapter,
            })
        }
    }

    /// 本进程此刻占用的显存（DXGI 本地段，字节）。
    pub fn vram(&self) -> u64 {
        let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
        unsafe {
            let _ =
                self.adapter
                    .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info);
        }
        info.CurrentUsage
    }

    pub fn pin(&self, hwnd: HWND, src: &Source) -> windows::core::Result<GpuPin> {
        unsafe {
            let desc = DXGI_SWAP_CHAIN_DESC1 {
                Width: 64,
                Height: 64,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
                ..Default::default()
            };
            let swap = self
                .factory
                .CreateSwapChainForComposition(&self.d3d, &desc, None)?;
            let dc = self
                .d2d
                .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
            let target = self.dcomp.CreateTargetForHwnd(hwnd, true)?;
            let visual = self.dcomp.CreateVisual()?;
            visual.SetContent(&swap)?;
            target.SetRoot(&visual)?;
            let l0 = &src.levels[0];
            let props = D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                colorContext: std::mem::ManuallyDrop::new(None),
            };
            let bitmap = dc.CreateBitmap(
                D2D_SIZE_U {
                    width: l0.width,
                    height: l0.height,
                },
                Some(l0.px.as_ptr() as *const _),
                l0.width * 4,
                &props,
            )?;
            let shadow = dc.CreateSolidColorBrush(
                &D2D1_COLOR_F {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                    a: 0.22,
                },
                None,
            )?;
            let mut pin = GpuPin {
                swap,
                dc,
                _target: target,
                _visual: visual,
                bitmap,
                size: (0, 0),
                shadow,
            };
            pin.resize(64, 64)?;
            Ok(pin)
        }
    }

    pub fn commit(&self) {
        unsafe {
            let _ = self.dcomp.Commit();
        }
    }
}

impl GpuPin {
    fn resize(&mut self, w: u32, h: u32) -> windows::core::Result<()> {
        if self.size == (w, h) {
            return Ok(());
        }
        unsafe {
            self.dc.SetTarget(None);
            self.swap
                .ResizeBuffers(0, w, h, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG(0))?;
            let surface: IDXGISurface = self.swap.GetBuffer(0)?;
            let props = D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                colorContext: std::mem::ManuallyDrop::new(None),
            };
            let target = self
                .dc
                .CreateBitmapFromDxgiSurface(&surface, Some(&props))?;
            self.dc.SetTarget(&target);
        }
        self.size = (w, h);
        Ok(())
    }

    /// 画可见部分 `vis`（窗口坐标）并 Present。返回（重设尺寸 µs，画 µs，Present µs）。
    pub fn draw(
        &mut self,
        src: &Source,
        view: &View,
        vis: Rect,
    ) -> windows::core::Result<(u64, u64, u64)> {
        let t0 = std::time::Instant::now();
        self.resize(vis.w as u32, vis.h as u32)?;
        let t1 = std::time::Instant::now();
        let (cw, ch) = view.content_size(src);
        let (dw, dh) = view.display_size(src);
        let (cw, ch) = (cw as f32, ch as f32);
        // 内容坐标 → 窗口位图坐标：先翻转，再顺时针转，再平移到阴影边里面、减去可见块的偏移。
        let map = |u: f32, v: f32| -> (f32, f32) {
            let u = if view.flip_h { cw - u } else { u };
            let v = if view.flip_v { ch - v } else { v };
            let (x, y) = match view.rotation % 4 {
                0 => (u, v),
                1 => (ch - v, u),
                2 => (cw - u, ch - v),
                _ => (v, cw - u),
            };
            (x + (PIN_EDGE - vis.x) as f32, y + (PIN_EDGE - vis.y) as f32)
        };
        let (ox, oy) = map(0.0, 0.0);
        let (ux, uy) = map(1.0, 0.0);
        let (vx, vy) = map(0.0, 1.0);
        let m = Matrix3x2 {
            M11: ux - ox,
            M12: uy - oy,
            M21: vx - ox,
            M22: vy - oy,
            M31: ox,
            M32: oy,
        };
        let crop = view.crop_rect(src);
        unsafe {
            self.dc.BeginDraw();
            self.dc.Clear(Some(&D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.0,
            }));
            self.dc.SetTransform(&Matrix3x2::identity());
            let e = PIN_EDGE as f32;
            let (x0, y0) = ((PIN_EDGE - vis.x) as f32, (PIN_EDGE - vis.y) as f32);
            let ring = [
                (x0 - e, y0 - e, x0 + dw as f32 + e, y0),
                (
                    x0 - e,
                    y0 + dh as f32,
                    x0 + dw as f32 + e,
                    y0 + dh as f32 + e,
                ),
                (x0 - e, y0, x0, y0 + dh as f32),
                (x0 + dw as f32, y0, x0 + dw as f32 + e, y0 + dh as f32),
            ];
            for (l, t, r, b) in ring {
                self.dc.FillRectangle(
                    &D2D_RECT_F {
                        left: l,
                        top: t,
                        right: r,
                        bottom: b,
                    },
                    &self.shadow,
                );
            }
            self.dc.SetTransform(&m);
            self.dc.DrawBitmap(
                &self.bitmap,
                Some(&D2D_RECT_F {
                    left: 0.0,
                    top: 0.0,
                    right: cw,
                    bottom: ch,
                }),
                1.0,
                D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC,
                Some(&D2D_RECT_F {
                    left: crop.x as f32,
                    top: crop.y as f32,
                    right: (crop.x + crop.w) as f32,
                    bottom: (crop.y + crop.h) as f32,
                }),
                None,
            );
            self.dc.EndDraw(None, None)?;
        }
        let t2 = std::time::Instant::now();
        unsafe { self.swap.Present(0, DXGI_PRESENT(0)).ok()? };
        let t3 = std::time::Instant::now();
        Ok((
            (t1 - t0).as_micros() as u64,
            (t2 - t1).as_micros() as u64,
            (t3 - t2).as_micros() as u64,
        ))
    }
}
