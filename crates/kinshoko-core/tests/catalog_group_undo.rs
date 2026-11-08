//! 撤销删除标签分组（#479）。
use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::TagTranslations;
use kinshoko_core::tag_catalog::{CatalogGroupDefinition, CatalogGroupEdit, TagCatalog};
use kinshoko_core::workspace::Workspace;
use std::path::Path;

fn open(app: &Path) -> (DeviceLibraries, TagCatalog, Workspace) {
    let device = DeviceLibraries::open(app).unwrap();
    let mut catalog = TagCatalog::open(app).unwrap();
    catalog
        .install_name_defaults(TagTranslations::bundled())
        .unwrap();
    (device, catalog, Workspace::open(app).unwrap())
}

fn names(catalog: &TagCatalog) -> Vec<String> {
    catalog
        .group_definitions()
        .unwrap()
        .into_iter()
        .map(|g| g.name)
        .collect()
}

/// 删除→撤销后，名称、在分组栏里的位置、成员及顺序都和删除前一致。
#[test]
fn undoing_a_group_delete_restores_name_position_and_ordered_members() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let (device, mut catalog, mut workspace) = open(&app);
    // 预置的“发色”“瞳色”已在；再建三个自己的分组，删中间那个。
    workspace
        .shared_tag_groups(&device, &mut catalog, "zh-CN", false)
        .unwrap();
    let a = catalog.create_group("甲", None).unwrap();
    let mid = catalog.create_group("乙", None).unwrap();
    let c = catalog.create_group("丙", None).unwrap();
    let tags: Vec<String> = catalog
        .group_definitions()
        .unwrap()
        .into_iter()
        .find(|g| g.name == "发色")
        .unwrap()
        .members;
    let vocabulary_edit = |catalog: &mut TagCatalog, workspace: &mut Workspace, edit| {
        workspace
            .edit_group(&device, catalog, &edit, false)
            .unwrap();
    };
    vocabulary_edit(
        &mut catalog,
        &mut workspace,
        CatalogGroupEdit::AddMembers {
            group_id: mid.clone(),
            tag_ids: vec![tags[2].clone(), tags[0].clone(), tags[1].clone()],
        },
    );
    let before: Vec<CatalogGroupDefinition> = catalog.group_definitions().unwrap();
    assert_eq!(names(&catalog), ["发色", "瞳色", "甲", "乙", "丙"]);

    let deleted = catalog.delete_group(&mid).unwrap();
    assert_eq!(names(&catalog), ["发色", "瞳色", "甲", "丙"]);
    // 其间新建的分组排在最后；撤销后“乙”仍回到“甲”“丙”之间。
    catalog.create_group("丁", None).unwrap();
    // 撤销用的内容经前端往返（序列化）后照样能放回。
    let deleted = serde_json::from_str(&serde_json::to_string(&deleted).unwrap()).unwrap();
    catalog.restore_group(deleted).unwrap();

    assert_eq!(names(&catalog), ["发色", "瞳色", "甲", "乙", "丙", "丁"]);
    let after = catalog.group_definitions().unwrap();
    assert_eq!(after[3], before[3]);
    assert_eq!(after[3].id, mid);
    assert_eq!(
        after[3].members,
        [tags[2].clone(), tags[0].clone(), tags[1].clone()]
    );
    let _ = (a, c);
}

/// 撤销两次、或分组已经在，都不重复也不报错。
#[test]
fn undoing_twice_does_not_duplicate_the_group() {
    let dir = tempfile::tempdir().unwrap();
    let (_, mut catalog, _) = open(&dir.path().join("app"));
    let id = catalog.create_group("甲", None).unwrap();
    let deleted = catalog.delete_group(&id).unwrap();
    catalog.restore_group(deleted.clone()).unwrap();
    catalog.restore_group(deleted).unwrap();
    assert_eq!(names(&catalog).iter().filter(|n| *n == "甲").count(), 1);
}

/// 删除预置分组并撤销：撤销后分组回来，重启后不会再被预置一份；删除后不撤销也不会被加回。
#[test]
fn undoing_a_preset_group_delete_neither_duplicates_nor_loses_the_preset() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let (device, mut catalog, mut workspace) = open(&app);
    let groups = workspace
        .shared_tag_groups(&device, &mut catalog, "zh-CN", true)
        .unwrap();
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["发色", "瞳色"]
    );
    let before = catalog.group_definitions().unwrap();
    let hair = before[0].id.clone();

    let deleted = catalog.delete_group(&hair).unwrap();
    // 删除后重启：不会被当成没预置过而加回。
    drop((catalog, workspace, device));
    let (device, mut catalog, mut workspace) = open(&app);
    assert_eq!(names(&catalog), ["瞳色"]);
    workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    assert_eq!(names(&catalog), ["瞳色"]);

    catalog.restore_group(deleted).unwrap();
    assert_eq!(catalog.group_definitions().unwrap(), before);
    // 撤销之后重启：仍是两组，不重复预置。
    drop((catalog, workspace, device));
    let (device, mut catalog, mut workspace) = open(&app);
    workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    assert_eq!(catalog.group_definitions().unwrap(), before);
}

/// 全部删光再逐个撤销：仍然不会触发重新预置。
#[test]
fn undoing_after_deleting_every_group_does_not_trigger_the_preset_again() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let (device, mut catalog, mut workspace) = open(&app);
    workspace
        .shared_tag_groups(&device, &mut catalog, "zh-CN", true)
        .unwrap();
    let before = catalog.group_definitions().unwrap();
    let deleted: Vec<_> = before
        .iter()
        .map(|g| catalog.delete_group(&g.id).unwrap())
        .collect();
    for d in deleted.into_iter().rev() {
        catalog.restore_group(d).unwrap();
    }
    assert_eq!(catalog.group_definitions().unwrap(), before);
    workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    assert_eq!(catalog.group_definitions().unwrap(), before);
}
