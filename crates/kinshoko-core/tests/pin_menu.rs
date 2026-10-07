//! 钉图右键菜单里的透明度与锁定（#64）：锁定后不响应拖动与缩放；透明度限制在 10%～100%；
//! 两者都随钉图状态保存，重新打开后恢复。

use kinshoko_core::desktop::{
    CaptureHistory, MIN_OPACITY, PinContent, PinStore, Placement, SavedPin, ScreenRect, Screenshot,
};

fn pin(id: &str, capture_id: &str) -> SavedPin {
    SavedPin {
        id: id.into(),
        content: PinContent::Capture {
            capture_id: capture_id.into(),
        },
        crop: None,
        width: 100,
        height: 50,
        placement: Placement {
            x: 200,
            y: 100,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
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

fn history_with_one(dir: &std::path::Path) -> (CaptureHistory, String) {
    let mut history = CaptureHistory::open(&dir.join("captures")).unwrap();
    let capture = history
        .add(&Screenshot {
            image: image::RgbaImage::new(100, 50),
            icc: None,
        })
        .unwrap();
    (history, capture.id)
}

#[test]
fn a_locked_pin_does_not_move_or_zoom() {
    let mut p = pin("p", "c");
    p.locked = true;
    assert!(!p.move_to(500, 500));
    assert!(!p.zoom(2.0, (250.0, 125.0)));
    assert_eq!(p.rect(), rect(200, 100, 100, 50));
}

#[test]
fn an_unlocked_pin_moves_and_zooms() {
    let mut p = pin("p", "c");
    assert!(p.move_to(300, 400));
    assert_eq!(p.rect(), rect(300, 400, 100, 50));
    assert!(p.zoom(2.0, (300.0, 400.0)));
    assert_eq!(p.rect(), rect(300, 400, 200, 100));
}

#[test]
fn opacity_stays_between_ten_percent_and_opaque() {
    assert_eq!(MIN_OPACITY, 0.1);
    let mut p = pin("p", "c");
    p.set_opacity(0.0);
    assert_eq!(p.opacity, 0.1);
    p.set_opacity(1.7);
    assert_eq!(p.opacity, 1.0);
    p.set_opacity(0.6);
    assert_eq!(p.opacity, 0.6);
    p.set_opacity(f64::NAN);
    assert_eq!(p.opacity, 1.0, "读不懂的值按不透明处理");
}

#[test]
fn opacity_and_lock_come_back_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let (mut history, capture) = history_with_one(dir.path());
    let mut saved = pin("p1", &capture);
    saved.set_opacity(0.4);
    saved.locked = true;
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(saved.clone());
    store.save().unwrap();
    drop(store);

    let mut store = PinStore::open(dir.path()).unwrap();
    let restored = store.restore(&mut history, &[rect(0, 0, 1920, 1080)]);
    assert_eq!(restored, vec![saved]);
}

#[test]
fn pins_saved_before_the_menu_existed_open_opaque_and_unlocked() {
    let dir = tempfile::tempdir().unwrap();
    let (mut history, capture) = history_with_one(dir.path());
    let old = format!(
        r#"{{"formatVersion":1,"pins":[{{"id":"p1","content":{{"kind":"capture","captureId":"{capture}"}},"crop":null,"width":100,"height":50,"placement":{{"x":5,"y":6,"scale":1.0,"flipH":false,"flipV":false,"rotation":0}}}}]}}"#
    );
    std::fs::write(dir.path().join("pins.json"), old).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    let restored = store.restore(&mut history, &[rect(0, 0, 1920, 1080)]);
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].opacity, 1.0);
    assert!(!restored[0].locked);
}
