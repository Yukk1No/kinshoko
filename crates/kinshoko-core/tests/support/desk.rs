//! 桌面上的参考组（#590）测试用的桌面：临时应用数据目录里的截图历史、参考组目录与 `pins.json`。

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::desktop::{CaptureHistory, PinContent, Placement, Region, SavedPin, Screenshot};
use kinshoko_core::library::ReferenceImage;
use kinshoko_core::reference_groups::{Desk, ReferenceGroups};

pub struct TestDesk {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub history: CaptureHistory,
    pub desk: Desk,
}

impl TestDesk {
    pub fn new() -> TestDesk {
        TestDesk::with(|_| {})
    }

    /// 先在应用数据目录里准备好旧数据（例如 `pins.json`、旧参考组），再打开桌面。
    pub fn with(prepare: impl FnOnce(&Path)) -> TestDesk {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        prepare(&root);
        let history = CaptureHistory::open(&root.join("captures")).unwrap();
        let desk = Desk::open(&root, groups(&root), &history).unwrap();
        TestDesk {
            _dir: dir,
            root,
            history,
            desk,
        }
    }

    pub fn groups(&self) -> ReferenceGroups {
        groups(&self.root)
    }

    /// 落盘后像重新启动一样再打开一次（截图历史也重新读）。
    pub fn restart(&mut self) -> Vec<SavedPin> {
        self.desk.flush().unwrap();
        self.history = CaptureHistory::open(&self.root.join("captures")).unwrap();
        self.desk = Desk::open(&self.root, groups(&self.root), &self.history).unwrap();
        let opened = self.desk.restore(&mut self.history, &[screen()]);
        assert!(opened.problems.is_empty(), "{:?}", opened.problems);
        opened.pins
    }

    /// 钉一张资料库参考图（资料库不必存在）。
    pub fn pin_reference(&mut self, id: &str, x: i32) -> SavedPin {
        self.desk
            .pin(reference_pin(id, x), &mut self.history)
            .unwrap()
    }

    /// 截一张图并钉上。
    pub fn pin_capture(&mut self, id: &str, seed: u8) -> SavedPin {
        let entry = self.history.add(&shot(seed)).unwrap();
        self.desk
            .pin(capture_pin(id, &entry.id), &mut self.history)
            .unwrap()
    }

    /// 参考组目录下这个参考组自带截图的文件。
    pub fn capture_files(&self, group_id: &str) -> Vec<String> {
        let dir = self
            .root
            .join("reference-groups")
            .join(format!("{group_id}.captures"));
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out: Vec<String> = read
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    pub fn group_file(&self, group_id: &str) -> PathBuf {
        self.root
            .join("reference-groups")
            .join(format!("{group_id}.json"))
    }
}

pub fn groups(root: &Path) -> ReferenceGroups {
    ReferenceGroups::open(&root.join("reference-groups")).unwrap()
}

pub fn screen() -> kinshoko_core::desktop::ScreenRect {
    kinshoko_core::desktop::ScreenRect {
        x: 0,
        y: 0,
        width: 3840,
        height: 2160,
    }
}

pub fn shot(seed: u8) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(30, 20, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: None,
    }
}

pub fn reference_pin(id: &str, x: i32) -> SavedPin {
    let image = ReferenceImage {
        id: format!("img-{id}"),
        width: 800,
        height: 600,
        sealed: false,
    };
    SavedPin::reference(
        id,
        "lib",
        &image,
        Some(Region {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
        }),
        Placement {
            x,
            y: 40,
            ..Default::default()
        },
    )
    .unwrap()
}

pub fn capture_pin(id: &str, capture_id: &str) -> SavedPin {
    SavedPin {
        id: id.into(),
        content: PinContent::Capture {
            capture_id: capture_id.into(),
        },
        crop: None,
        width: 30,
        height: 20,
        placement: Placement {
            x: 500,
            y: 70,
            ..Default::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}
