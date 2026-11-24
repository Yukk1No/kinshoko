//! 资料库钉图的原位遮蔽（#65）：安全模式开关由应用设置直接告诉钉图，不依赖资料库是否打开。
//! 通过 `kinshoko_core::desktop::PinVeils` 的对外接口。

use kinshoko_core::desktop::{PinContent, PinVeils, Placement, SavedPin};
use kinshoko_core::library::ReferenceImage;

fn reference(id: &str) -> SavedPin {
    let image = ReferenceImage {
        id: "img".into(),
        width: 10,
        height: 10,
        sealed: false,
    };
    SavedPin::reference(id, "lib", &image, None, Placement::default()).unwrap()
}

fn capture() -> SavedPin {
    SavedPin {
        content: PinContent::Capture {
            capture_id: "c".into(),
        },
        ..reference("cap")
    }
}

#[test]
fn turning_safe_mode_on_with_no_library_open_veils_shown_library_pins() {
    let mut veils = PinVeils::new(false);
    let pin = reference("p1");
    // 安全模式关着：资料库没打开、核对不了的钉图也照常显示。
    assert!(!veils.veiled(&pin, None));

    // 只有应用设置变了，没有任何资料库事件。
    assert!(veils.set_safe_mode(true), "开启是一次变化，钉图要重新核对");
    assert!(veils.veiled(&pin, None), "核对不了时按被封印处理");
    assert!(veils.veiled(&pin, Some(true)));
    assert!(!veils.veiled(&pin, Some(false)));
    assert!(!veils.set_safe_mode(true), "没变化");
}

#[test]
fn a_confirmed_pin_is_shown_until_safe_mode_is_turned_on_again() {
    let mut veils = PinVeils::new(true);
    let pin = reference("p1");
    let other = reference("p2");
    veils.reveal("p1");
    assert!(!veils.veiled(&pin, Some(true)), "确认后只显示这一张");
    assert!(veils.veiled(&other, Some(true)));

    assert!(veils.set_safe_mode(false));
    assert!(!veils.veiled(&other, None), "安全模式关掉后都不遮蔽");
    assert!(veils.set_safe_mode(true));
    assert!(veils.veiled(&pin, Some(true)), "重新开启时之前的确认作废");

    veils.reveal("p1");
    veils.forget("p1");
    assert!(veils.veiled(&pin, Some(true)), "钉图关闭后确认不留");
}

#[test]
fn capture_pins_are_never_veiled() {
    let veils = PinVeils::new(true);
    assert!(!veils.veiled(&capture(), None));
}
