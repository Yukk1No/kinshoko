use super::*;
use kinshoko_core::desktop::{
    CaptureSelection, CaptureSurface, OriginalPixels, Placement, Region, SavedPin, ScreenRect,
    Screenshot,
};
use kinshoko_core::library::ReferenceImage;
use windows_sys::Win32::Graphics::Dwm::DWMWA_CLOAK;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, SW_SHOWNOACTIVATE, SetLayeredWindowAttributes, ShowWindow,
    WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

/// 测试用的顶层窗口，离开作用域时销毁。
struct Window(HWND);
impl Window {
    fn new(rect: ScreenRect, ex_style: u32) -> Self {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY：系统内置的 STATIC 窗口类；参数都是本函数持有的值。
        let hwnd = unsafe {
            CreateWindowExW(
                ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class.as_ptr(),
                ptr::null(),
                WS_POPUP,
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "创建测试窗口失败");
        Self(hwnd)
    }
    fn show(self) -> Self {
        // SAFETY：句柄由本测试创建，尚未销毁。
        unsafe { ShowWindow(self.0, SW_SHOWNOACTIVATE) };
        self
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY：句柄由本测试创建，只销毁一次。
        unsafe { DestroyWindow(self.0) };
    }
}

fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

/// #125：Raycast 之类的启动器常驻一个“可见”、置顶、鼠标穿透、整窗透明度为 0 的窗口，
/// 云化（cloaked）的窗口同样不画任何东西。它们不能把下面的参考图算成被遮住，
/// 否则选区完全落在图内也只读屏幕像素。真正画在上面的窗口仍算遮挡。
#[test]
fn windows_that_draw_nothing_do_not_cover_the_reference() {
    // 本机验收的几何：110% 缩放、窗口最大化，1117×701 的图按原始像素显示在 (722, 374)。
    let shown = rect(722, 374, 1117, 701);
    let main = Window::new(shown, 0).show();
    // 桌面上别的窗口（通知、其他程序）随时可能出现在上面；只比较本测试自己加上去的窗口。
    let before = covering_windows(main.0 as isize).expect("Z 序可遍历");
    let invisible = Window::new(shown, WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT);
    // SAFETY：句柄由本测试创建。
    assert_ne!(
        unsafe { SetLayeredWindowAttributes(invisible.0, 0, 0, LWA_ALPHA) },
        0
    );
    let invisible = invisible.show();
    let cloaked = Window::new(shown, WS_EX_TOPMOST);
    let cloak: i32 = 1;
    // SAFETY：句柄由本测试创建；值是本函数持有的 BOOL。
    let hr = unsafe {
        DwmSetWindowAttribute(
            cloaked.0,
            DWMWA_CLOAK as u32,
            (&cloak as *const i32).cast(),
            size_of::<i32>() as u32,
        )
    };
    assert_eq!(hr, 0, "云化测试窗口失败");
    let cloaked = cloaked.show();
    let corner = rect(722, 374, 40, 30);
    let opaque = Window::new(corner, WS_EX_TOPMOST).show();
    // #193：钉图层铺满显示器，窗口区域只盖住钉图本身。按区域算遮挡，不按外框；
    // 区域为空（什么都不显示）的不算。
    let pinned = rect(1800, 1000, 30, 20);
    let big = Window::new(rect(0, 0, 2560, 1440), WS_EX_TOPMOST);
    // 两个分开的钉图：它们之间的空隙不算遮挡。
    let apart = rect(100, 100, 30, 20);
    assert!(set_window_region(
        big.0 as isize,
        &[(1800, 1000, 1830, 1020), (100, 100, 130, 120)]
    ));
    let big = big.show();
    let empty = Window::new(rect(0, 0, 2560, 1440), WS_EX_TOPMOST);
    assert!(set_window_region(empty.0 as isize, &[]));
    let empty = empty.show();

    let mut covered = covering_windows(main.0 as isize).expect("Z 序可遍历");
    for r in &before {
        if let Some(i) = covered.iter().position(|c| c == r) {
            covered.remove(i);
        }
    }
    // 不画任何东西的窗口不算遮挡，真正画在上面的窗口仍算；有窗口区域的按区域算。
    assert_eq!(covered, vec![apart, pinned, corner]);

    let image = ReferenceImage {
        id: "a".into(),
        width: 1117,
        height: 701,
        sealed: false,
    };
    let surfaces = [CaptureSurface {
        pin: SavedPin::reference("a", "library", &image, None, Placement::default()).unwrap(),
        shown,
        visible: shown,
        covered,
    }];
    let screen = Screenshot {
        image: image::RgbaImage::new(1, 1),
        icc: None,
    };
    let readout = |region: Region| {
        CaptureSelection {
            screen: &screen,
            origin: (0, 0),
            region,
            references: &surfaces,
        }
        .original_pixels()
    };
    // 图中央约 100×80 CSS px 的选区（111×89 物理像素）：原始像素。
    let inside = Region {
        x: 1225,
        y: 680,
        width: 111,
        height: 89,
    };
    assert_eq!(
        readout(inside),
        Some(OriginalPixels {
            width: 111,
            height: 89
        })
    );
    // 跨出图片左缘：屏幕像素。
    let crossing = Region {
        x: 672,
        y: 680,
        width: 111,
        height: 89,
    };
    assert_eq!(readout(crossing), None);
    drop((empty, big, opaque, cloaked, invisible));
}

/// #194：钉图菜单窗口关掉系统的显示、隐藏过渡。窗口已销毁时如实报告失败。
#[test]
fn transitions_can_be_turned_off_for_a_live_window_only() {
    let window = Window::new(rect(0, 0, 200, 100), WS_EX_TOPMOST);
    let hwnd = window.0 as isize;
    assert!(disable_transitions(hwnd));
    drop(window);
    assert!(!disable_transitions(hwnd));
}

/// 钉图层与菜单窗口标成工具窗口后不再让 WebView2 把下面的窗口算成被挡住。窗口已销毁时如实报告失败。
#[test]
fn layers_can_be_marked_as_tool_windows_while_live() {
    let window = Window::new(rect(0, 0, 200, 100), WS_EX_TOPMOST);
    let hwnd = window.0 as isize;
    let style = || unsafe { GetWindowLongW(window.0, GWL_EXSTYLE) } as u32;
    // SAFETY：句柄由本测试创建；先去掉测试窗口自带的工具窗口样式。
    unsafe { SetWindowLongW(window.0, GWL_EXSTYLE, (style() & !WS_EX_TOOLWINDOW) as i32) };
    assert_eq!(style() & WS_EX_TOOLWINDOW, 0);
    assert!(mark_tool_window(hwnd));
    assert_ne!(style() & WS_EX_TOOLWINDOW, 0);
    assert_ne!(style() & WS_EX_TOPMOST, 0);
    drop(window);
    assert!(!mark_tool_window(hwnd));
}
