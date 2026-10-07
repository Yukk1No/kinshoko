//! 钉图状态恢复（#63）：重新打开后恢复钉图的位置、裁切、翻转与旋转。
//! 通过 `kinshoko_core::desktop` 的对外接口，用临时目录里的真文件。

use image::RgbaImage;
use kinshoko_core::desktop::{
    CaptureHistory, HISTORY_LIMIT, PinContent, PinStore, Placement, Region, SavedPin, ScreenRect,
    Screenshot,
};

const MONITOR: ScreenRect = ScreenRect {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
};

fn shot(w: u32, h: u32, seed: u8) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(w, h, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: None,
    }
}

fn pin(id: &str, capture_id: &str, x: i32, y: i32) -> SavedPin {
    SavedPin {
        id: id.to_owned(),
        content: PinContent::Capture {
            capture_id: capture_id.to_owned(),
        },
        crop: None,
        width: 120,
        height: 80,
        placement: Placement {
            x,
            y,
            ..Placement::default()
        },
        opacity: 1.0,
        locked: false,
    }
}

#[test]
fn pins_come_back_with_position_crop_flip_and_rotation_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history.add(&shot(120, 80, 1)).unwrap();

    let mut saved = pin("p1", &capture.id, 300, 200);
    saved.crop = Some(Region {
        x: 10,
        y: 5,
        width: 60,
        height: 40,
    });
    saved.width = 60;
    saved.height = 40;
    saved.placement.flip_h = true;
    saved.placement.rotation = 3;
    saved.placement.scale = 1.5;
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(saved.clone());
    store.save().unwrap();
    drop(store);

    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    let restored = store.restore(&mut history, &[MONITOR]);
    assert_eq!(restored, vec![saved]);
    assert!(history.entries()[0].pinned, "恢复的钉图仍钉住它的截图");
}

#[test]
fn a_closed_pin_is_not_restored() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history.add(&shot(120, 80, 1)).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin("p1", &capture.id, 10, 10));
    store.put(pin("p2", &capture.id, 50, 50));
    store.remove("p1");
    store.save().unwrap();

    let mut store = PinStore::open(dir.path()).unwrap();
    let ids: Vec<String> = store
        .restore(&mut history, &[MONITOR])
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids, ["p2"]);
}

#[test]
fn a_pin_whose_capture_is_gone_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin("p1", "no-such-capture", 10, 10));
    assert!(store.restore(&mut history, &[MONITOR]).is_empty());
    assert!(store.get("p1").is_none());
}

#[test]
fn a_pinned_capture_beyond_the_history_limit_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let captures = dir.path().join("captures");
    let mut history = CaptureHistory::open(&captures).unwrap();
    let old = history.add(&shot(120, 80, 0)).unwrap();
    history.pin(&old.id);
    for seed in 1..=HISTORY_LIMIT as u8 {
        history.add(&shot(120, 80, seed)).unwrap();
    }
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin("p1", &old.id, 10, 10));
    store.save().unwrap();
    drop(history);

    let mut history = CaptureHistory::open(&captures).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    assert_eq!(store.restore(&mut history, &[MONITOR]).len(), 1);
    // 再来一张新截图也不会把它丢掉：恢复的钉图还钉着它。
    history.add(&shot(120, 80, 99)).unwrap();
    assert!(history.file(&old.id).unwrap().exists());
}

#[test]
fn a_pin_left_on_a_monitor_that_is_gone_is_pulled_back_onto_the_screen() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history.add(&shot(120, 80, 1)).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin("right", &capture.id, 2500, 300));
    store.put(pin("above", &capture.id, 100, -500));
    let restored = store.restore(&mut history, &[MONITOR]);
    let at = |id: &str| {
        let p = restored.iter().find(|p| p.id == id).unwrap();
        (p.placement.x, p.placement.y)
    };
    // 至少 64 像素留在显示器上，能抓住拖回来。
    assert_eq!(at("right"), (1920 - 64, 300));
    assert_eq!(at("above"), (100, -80 + 64));
}

#[test]
fn a_pin_partly_off_screen_but_still_reachable_stays_where_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history.add(&shot(120, 80, 1)).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    store.put(pin("p", &capture.id, -30, 1040));
    let restored = store.restore(&mut history, &[MONITOR]);
    assert_eq!(
        (restored[0].placement.x, restored[0].placement.y),
        (-30, 1080 - 64)
    );
}

#[test]
fn an_unreadable_pin_file_starts_empty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("pins.json"), b"{not json").unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let mut store = PinStore::open(dir.path()).unwrap();
    assert!(store.restore(&mut history, &[MONITOR]).is_empty());
}
