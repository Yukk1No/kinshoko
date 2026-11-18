//! 参考组自带截图（#270，ADR-0002 修订）：截图可以只存在参考组里，不进任何资料库。
//! 截图历史清空后重新摆到桌面上，组内截图照常按原布局钉出；没有成员再用它时文件随之删除；
//! 参考组包带上组内截图；只引用资料库的旧参考组文件不迁移也照常读写。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

#[path = "support/group_fixture.rs"]
mod group_fixture;
use group_fixture::{open_group, save_group_with_history};

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::desktop::{
    CaptureHistory, GroupMemberRef, PinContent, Placement, Region, SavedPin, Screenshot,
};
use kinshoko_core::library::{BrowseQuery, ReferenceLens};
use kinshoko_core::reference_groups::{
    MemberSource, MemberState, ReferenceGroups, ReferenceSource, UnavailableReason,
};

fn shot(seed: u8) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(30, 20, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: None,
    }
}

fn capture_pin(id: &str, capture_id: &str, x: i32) -> SavedPin {
    SavedPin {
        id: id.into(),
        content: PinContent::Capture {
            capture_id: capture_id.into(),
        },
        crop: Some(Region {
            x: 2,
            y: 3,
            width: 12,
            height: 9,
        }),
        width: 12,
        height: 9,
        placement: Placement {
            x,
            y: 70,
            scale: 2.0,
            flip_h: true,
            flip_v: false,
            rotation: 3,
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

/// 没有任何资料库：资料库成员都暂时不可用。
struct NoLibraries;

impl ReferenceSource for NoLibraries {
    fn lens(&self, _: &str) -> Result<ReferenceLens, UnavailableReason> {
        Err(UnavailableReason::LibraryNotRegistered)
    }
}

/// `dir` 下（含子文件夹）的全部文件。
fn files_in(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(files_in(&path));
        } else {
            out.push(path.to_string_lossy().into_owned());
        }
    }
    out
}

fn images(library: &Library) -> u32 {
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            conditions: Default::default(),
            cursor: None,
            limit: 10,
            thumbnail_px: 64,
        })
        .unwrap()
        .total
}

struct Desk {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    history: CaptureHistory,
    groups: ReferenceGroups,
}

impl Desk {
    fn new() -> Desk {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        Desk {
            history: CaptureHistory::open(&root.join("captures")).unwrap(),
            groups: ReferenceGroups::open(&root.join("reference-groups")).unwrap(),
            root,
            _dir: dir,
        }
    }

    /// 截一张图钉到桌面，存成只有这张截图的参考组（只存在参考组里）。
    fn group_with_capture(
        &mut self,
        seed: u8,
    ) -> (
        kinshoko_core::reference_groups::ReferenceGroup,
        SavedPin,
        Vec<u8>,
    ) {
        let entry = self.history.add(&shot(seed)).unwrap();
        let bytes = std::fs::read(self.history.file(&entry.id).unwrap()).unwrap();
        let mut pins = vec![capture_pin("p1", &entry.id, 300)];
        let group =
            save_group_with_history(&self.groups, &mut self.history, "一次性参考", &mut pins)
                .unwrap();
        (group, pins.remove(0), bytes)
    }

    /// 截图历史清空：换一个全新的截图历史目录。
    fn clear_history(&mut self) {
        self.history = CaptureHistory::open(&self.root.join("captures-after")).unwrap();
    }
}

#[test]
fn a_capture_kept_only_in_the_group_never_enters_a_library_and_reopens_after_history_is_cleared() {
    let mut desk = Desk::new();
    let library = Library::create(&desk.root.join("library"), "资料库").unwrap();
    let (group, saved_pin, bytes) = desk.group_with_capture(5);

    assert_eq!(group.members.len(), 1);
    let member = &group.members[0];
    assert!(matches!(member.source, MemberSource::Capture { .. }));
    assert_eq!((member.source_width, member.source_height), (30, 20));
    assert_eq!(member.crop, saved_pin.crop);
    assert_eq!(member.placement, saved_pin.placement);
    assert_eq!(
        saved_pin.member,
        Some(GroupMemberRef {
            group_id: group.id.clone(),
            member_id: member.id.clone()
        }),
        "存进去的截图钉图记得成了哪个成员"
    );
    assert!(group.library_ids().is_empty(), "不引用任何资料库");
    assert_eq!(images(&library), 0, "资料库与瀑布流里没有它");

    // 关掉钉图、截图历史清空之后，重新打开参考组。
    desk.clear_history();
    let reread = desk.groups.get(&group.id).unwrap();
    let opened = open_group(&desk.groups, &mut desk.history, &reread.id).unwrap();
    assert!(opened.problems.is_empty(), "{:?}", opened.problems);
    assert_eq!(opened.pins.len(), 1);
    let pin = &opened.pins[0];
    assert_eq!(pin.crop, saved_pin.crop);
    assert_eq!(pin.placement, saved_pin.placement);
    assert_eq!((pin.width, pin.height), (12, 9));
    assert_eq!(pin.member, saved_pin.member);
    let capture = pin.capture_id().expect("钉出的是截图钉图");
    let entry = desk.history.entry(capture).unwrap();
    assert!(entry.pinned, "截图历史知道它正被钉住");
    assert_eq!(
        std::fs::read(desk.history.file(capture).unwrap()).unwrap(),
        bytes,
        "按字节还原，从不重编码"
    );
}

#[test]
fn a_group_capture_shows_normally_in_safe_mode_and_reports_a_missing_file() {
    let mut desk = Desk::new();
    let (group, _, _) = desk.group_with_capture(1);
    let view = desk.groups.view(group.clone(), &NoLibraries);
    assert_eq!(
        view.members[0].state,
        MemberState::Available { sealed: false }
    );

    let file = desk
        .groups
        .capture_path(&group.id, &group.members[0].id)
        .unwrap();
    std::fs::remove_file(file).unwrap();
    let view = desk.groups.view(group.clone(), &NoLibraries);
    assert!(matches!(
        view.members[0].state,
        MemberState::Unavailable {
            reason: UnavailableReason::CaptureMissing,
            ..
        }
    ));
    // 截图历史里也没有了：钉不出来，说明原因。
    desk.clear_history();
    let opened = open_group(&desk.groups, &mut desk.history, &group.id).unwrap();
    assert!(opened.pins.is_empty());
    assert_eq!(opened.problems.len(), 1);
}

#[test]
fn a_group_capture_file_is_deleted_once_no_member_uses_it() {
    let mut desk = Desk::new();
    let (group, _, _) = desk.group_with_capture(3);
    let file = desk
        .groups
        .capture_path(&group.id, &group.members[0].id)
        .unwrap();
    assert!(file.is_file());

    desk.groups
        .remove_member(&group.id, &group.members[0].id)
        .unwrap();
    assert!(!file.exists(), "移除成员后截图文件也删掉");

    let (second, _, _) = desk.group_with_capture(4);
    let file = desk
        .groups
        .capture_path(&second.id, &second.members[0].id)
        .unwrap();
    desk.groups.delete(&second.id).unwrap();
    assert!(!file.exists(), "删除参考组后截图文件也删掉");
    assert!(
        !files_in(&desk.root.join("reference-groups"))
            .iter()
            .any(|f| f.ends_with(".png")),
        "没有留下截图文件"
    );
}

#[test]
fn a_group_capture_travels_in_a_reference_group_package() {
    let mut desk = Desk::new();
    let library = Library::create(&desk.root.join("library"), "资料库").unwrap();
    let (group, _, bytes) = desk.group_with_capture(8);
    let package = desk.root.join("out.kinshoko-group");
    desk.groups
        .export_package(&group.id, &NoLibraries, &package)
        .unwrap();

    let elsewhere = ReferenceGroups::open(&desk.root.join("elsewhere")).unwrap();
    let imported = elsewhere.import_package(&package, &library).unwrap();
    assert_ne!(imported.id, group.id);
    assert_eq!(imported.members.len(), 1);
    assert_eq!(imported.members[0].source, group.members[0].source);
    assert_eq!(imported.members[0].placement, group.members[0].placement);
    let file = elsewhere
        .capture_path(&imported.id, &imported.members[0].id)
        .unwrap();
    assert_eq!(std::fs::read(file).unwrap(), bytes);
    assert_eq!(images(&library), 0, "组内截图不进导入的资料库");
}

#[test]
fn an_existing_group_file_reads_and_writes_without_migration() {
    let desk = Desk::new();
    let id = "0123456789abcdef0123456789abcdef";
    let old = format!(
        r#"{{
  "format": "kinshoko.reference-group",
  "formatVersion": 1,
  "id": "{id}",
  "name": "旧参考组",
  "createdAt": 1,
  "updatedAt": 2,
  "members": [
    {{
      "id": "m1",
      "libraryId": "lib",
      "imageId": "img",
      "sourceWidth": 800,
      "sourceHeight": 600,
      "crop": null,
      "placement": {{ "x": 1, "y": 2, "scale": 1.0, "flipH": false, "flipV": false, "rotation": 0 }}
    }}
  ]
}}"#
    );
    let path = desk
        .root
        .join("reference-groups")
        .join(format!("{id}.json"));
    std::fs::write(&path, old).unwrap();

    let group = desk.groups.get(id).unwrap();
    assert_eq!(
        group.members[0].source,
        MemberSource::Library {
            library_id: "lib".into(),
            image_id: "img".into()
        }
    );
    desk.groups.rename(id, "改名").unwrap();
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(written["formatVersion"], 1, "只引用资料库时格式不变");
    assert_eq!(written["members"][0]["libraryId"], "lib");
    assert_eq!(written["members"][0]["imageId"], "img");
}
