//! 平台层给的 Surface 目标跨线程交给渲染线程。`wgpu::SurfaceTargetUnsafe` 里是裸指针，不能
//! 跨线程；Windows 的目标是 DComp visual，这里只记下地址，到渲染线程上再还原、建 Surface。
//! 建 Surface 是这个 crate 除 `desktop/win32.rs` 外唯一要 `unsafe` 的地方。

#![allow(unsafe_code)]

/// 能跨线程的 Surface 目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target(usize);

impl Target {
    /// 只认 DComp visual（Windows 平台层给的）。
    pub fn of(target: &wgpu::SurfaceTargetUnsafe) -> Result<Target, String> {
        match target {
            #[cfg(windows)]
            wgpu::SurfaceTargetUnsafe::CompositionVisual(visual) => Ok(Target(*visual as usize)),
            _ => Err("不认识的 Surface 目标".into()),
        }
    }

    #[cfg(windows)]
    fn target(self) -> wgpu::SurfaceTargetUnsafe {
        wgpu::SurfaceTargetUnsafe::CompositionVisual(self.0 as *mut core::ffi::c_void)
    }
}

/// 给一张钉图的两个槽建 Surface。
///
/// 前提（编排保证）：平台层在渲染层报 `Detached`（这两个 Surface 都已丢掉）之后才关窗口、
/// 放掉 visual，所以 visual 活得比 Surface 久。
#[cfg(windows)]
pub fn surfaces(
    renderer: &pin_render::Renderer,
    targets: [Target; 2],
) -> Result<[pin_render::Surface; 2], pin_render::Error> {
    // SAFETY：visual 由平台层持有，在 Surface 丢掉之前不释放（见上）。
    let [a, b] = targets.map(|t| unsafe { renderer.surface(t.target()) });
    Ok([a?, b?])
}

#[cfg(not(windows))]
pub fn surfaces(
    _: &pin_render::Renderer,
    _: [Target; 2],
) -> Result<[pin_render::Surface; 2], pin_render::Error> {
    Err(pin_render::Error::Surface("只支持 Windows".into()))
}
