//! 钉图的统一样式菜单（#102 T5，#106）：钉图窗口小且透明，菜单由独立的置顶无边框菜单窗口承载。
//! 菜单窗口盖住指针所在的显示器（让出最下面一行，免得被当成全屏程序，#230），菜单从指针处弹出，
//! 由页面保持在窗口内。
//! 这里测窗口放在哪、锚点在哪，以及菜单要显示的状态。

use kinshoko_core::desktop::{
    GroupMemberRef, MenuSurface, PinContent, PinMenu, Placement, SavedPin, ScreenRect, menu_surface,
};

fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

/// 主显示器 2560×1440（150%），右侧一台 1920×1080（125%）略低一些，左侧一台 1920×1080 在负坐标。
fn monitors() -> Vec<ScreenRect> {
    vec![
        rect(0, 0, 2560, 1440),
        rect(2560, 200, 1920, 1080),
        rect(-1920, 0, 1920, 1080),
    ]
}

#[test]
fn the_menu_window_covers_the_monitor_under_the_pointer_short_of_the_bottom_row() {
    assert_eq!(
        menu_surface((300, 400), &monitors()),
        Some(MenuSurface {
            window: rect(0, 0, 2560, 1439),
            x: 300,
            y: 400,
        })
    );
    assert_eq!(
        menu_surface((3000, 1000), &monitors()),
        Some(MenuSurface {
            window: rect(2560, 200, 1920, 1079),
            x: 440,
            y: 800,
        })
    );
}

#[test]
fn a_monitor_left_of_the_primary_has_negative_coordinates() {
    assert_eq!(
        menu_surface((-100, 50), &monitors()),
        Some(MenuSurface {
            window: rect(-1920, 0, 1920, 1079),
            x: 1820,
            y: 50,
        })
    );
}

#[test]
fn right_and_bottom_edges_belong_to_the_next_monitor() {
    let s = menu_surface((2560, 300), &monitors()).unwrap();
    assert_eq!(s.window, rect(2560, 200, 1920, 1079));
    assert_eq!((s.x, s.y), (0, 100));
    // 最下面一行不在菜单窗口里：锚点夹到窗口最下面一行。
    let s = menu_surface((2559, 1439), &monitors()).unwrap();
    assert_eq!(s.window, rect(0, 0, 2560, 1439));
    assert_eq!((s.x, s.y), (2559, 1438));
}

#[test]
fn a_pointer_in_a_gap_between_monitors_uses_the_nearest_one_and_stays_inside_it() {
    // 右侧显示器从 y=200 开始：(3000, 100) 在两台之间的空隙里，离右侧那台最近。
    let s = menu_surface((3000, 100), &monitors()).unwrap();
    assert_eq!(s.window, rect(2560, 200, 1920, 1079));
    assert_eq!((s.x, s.y), (440, 0));
    // 远在右下方：夹到右侧显示器的右下角里面。
    let s = menu_surface((9000, 9000), &monitors()).unwrap();
    assert_eq!(s.window, rect(2560, 200, 1920, 1079));
    assert_eq!((s.x, s.y), (1919, 1078));
}

#[test]
fn without_monitors_there_is_no_menu_window() {
    assert_eq!(menu_surface((0, 0), &[]), None);
}

fn capture_pin() -> SavedPin {
    SavedPin {
        id: "p1".into(),
        content: PinContent::Capture {
            capture_id: "c1".into(),
        },
        crop: None,
        width: 100,
        height: 50,
        placement: Placement::default(),
        opacity: 0.7,
        locked: false,
        member: None,
    }
}

fn reference_pin() -> SavedPin {
    SavedPin {
        id: "p2".into(),
        content: PinContent::Reference {
            library_id: "L1".into(),
            image_id: "I1".into(),
            source_width: 400,
            source_height: 300,
        },
        crop: None,
        width: 400,
        height: 300,
        placement: Placement {
            scale: 0.5,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: true,
        member: Some(GroupMemberRef {
            group_id: "g1".into(),
            member_id: "m1".into(),
        }),
    }
}

#[test]
fn a_capture_pin_menu_carries_its_state() {
    let menu = PinMenu::new(&capture_pin(), false, true, None);
    assert_eq!(
        menu,
        PinMenu {
            pin: "p1".into(),
            capture: true,
            opacity: 70,
            locked: false,
            actual_size: true,
            veiled: false,
            can_collect: true,
            group: None,
        }
    );
}

#[test]
fn a_reference_pin_menu_knows_its_group_and_veil() {
    let menu = PinMenu::new(&reference_pin(), true, true, Some("光影".into()));
    assert!(!menu.capture);
    assert!(menu.locked);
    assert!(!menu.actual_size);
    assert!(menu.veiled);
    assert_eq!(menu.group.as_deref(), Some("光影"));
    // 资料库钉图已在库里，不再收藏。
    assert!(!menu.can_collect);
}

#[test]
fn a_capture_cannot_be_collected_without_a_library() {
    assert!(!PinMenu::new(&capture_pin(), false, false, None).can_collect);
}

#[test]
fn open_in_kinshoko_goes_to_the_reference_or_to_the_capture_history() {
    use kinshoko_core::desktop::OpenInKinshoko;
    assert_eq!(
        OpenInKinshoko::of(&reference_pin()),
        OpenInKinshoko::Reference {
            library_id: "L1".into(),
            image_id: "I1".into(),
        }
    );
    assert_eq!(
        OpenInKinshoko::of(&capture_pin()),
        OpenInKinshoko::Capture {
            capture_id: "c1".into(),
        }
    );
}
