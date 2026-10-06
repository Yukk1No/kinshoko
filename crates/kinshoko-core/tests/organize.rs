//! 整理：文件夹、备注与可恢复删除（#50）。
//! 全部通过 `Library` 的对外接口（`edit`／`sidebar`／`browse`／`image` 与文件夹编辑），
//! 用临时目录里的真 SQLite 与真文件。

use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, Error, FolderNode, ImageEdit, ImportOutcome, ImportSource,
};

fn write_png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

/// 新建资料库并导入 `n` 张内容不同的图，返回参考图 id（按导入顺序）。
fn library_with(dir: &Path, n: u8) -> (Library, Vec<String>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let files: Vec<PathBuf> = (0..n)
        .map(|i| write_png(&dir.join(format!("in/{i:02}.png")), i))
        .collect();
    let report = library.import(ImportSource { paths: files }).wait();
    let ids = report
        .items
        .iter()
        .map(|item| match &item.outcome {
            ImportOutcome::Imported { image_id } => image_id.clone(),
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    (library, ids)
}

/// 范围内的全部参考图 id，按浏览顺序。
fn browse(library: &Library, scope: BrowseScope) -> Vec<String> {
    library
        .browse(&BrowseQuery {
            scope,
            cursor: None,
            limit: 1000,
            thumbnail_px: 256,
        })
        .unwrap()
        .cards
        .into_iter()
        .map(|c| c.id)
        .collect()
}

/// 文件夹树写成 `名称(计数)[子文件夹…]`，便于整体比较。
fn tree(nodes: &[FolderNode]) -> String {
    nodes
        .iter()
        .map(|n| {
            if n.children.is_empty() {
                format!("{}({})", n.name, n.count)
            } else {
                format!("{}({})[{}]", n.name, n.count, tree(&n.children))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn folders_can_be_created_nested_renamed_and_moved() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _) = library_with(dir.path(), 0);

    let people = library.create_folder("人物", None).unwrap();
    let hair = library.create_folder("发型", Some(&people)).unwrap();
    let scenes = library.create_folder("场景", None).unwrap();
    library.create_folder("刘海", Some(&hair)).unwrap();
    assert_eq!(
        tree(&library.sidebar().unwrap().folders),
        "人物(0)[发型(0)[刘海(0)]] 场景(0)"
    );

    library.rename_folder(&hair, "发型与刘海").unwrap();
    // 移到“场景”下，作为它的第一个子文件夹。
    library.move_folder(&hair, Some(&scenes), 0).unwrap();
    // 顶层顺序：把“场景”移到最前。
    library.move_folder(&scenes, None, 0).unwrap();

    assert_eq!(
        tree(&library.sidebar().unwrap().folders),
        "场景(0)[发型与刘海(0)[刘海(0)]] 人物(0)"
    );
}

#[test]
fn a_folder_cannot_be_moved_into_itself_or_its_subfolders() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _) = library_with(dir.path(), 0);
    let people = library.create_folder("人物", None).unwrap();
    let hair = library.create_folder("发型", Some(&people)).unwrap();

    assert!(matches!(
        library.move_folder(&people, Some(&hair), 0),
        Err(Error::FolderCycle)
    ));
    assert!(matches!(
        library.move_folder(&people, Some(&people), 0),
        Err(Error::FolderCycle)
    ));
    assert!(matches!(
        library.create_folder("  ", None),
        Err(Error::InvalidName)
    ));
    assert_eq!(
        tree(&library.sidebar().unwrap().folders),
        "人物(0)[发型(0)]"
    );
}

#[test]
fn folder_tree_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _) = library_with(dir.path(), 0);
    let a = library.create_folder("甲", None).unwrap();
    library.create_folder("乙", Some(&a)).unwrap();
    library.create_folder("丙", None).unwrap();
    let before = library.sidebar().unwrap();
    drop(library);

    let reopened = Library::open(&dir.path().join("lib")).unwrap();
    assert_eq!(reopened.sidebar().unwrap(), before);
}

#[test]
fn an_image_can_sit_in_several_folders_and_each_folder_lists_it() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 3);
    let hair = library.create_folder("发型", None).unwrap();
    let pose = library.create_folder("姿势", None).unwrap();

    // 一次批量：前两张放进“发型”，第一张同时放进“姿势”。
    let details = library
        .edit(
            &ids[0..2],
            &[ImageEdit::AddToFolder {
                folder_id: hair.clone(),
            }],
        )
        .unwrap();
    assert_eq!(details.len(), 2);
    let details = library
        .edit(
            &ids[0..1],
            &[ImageEdit::AddToFolder {
                folder_id: pose.clone(),
            }],
        )
        .unwrap();
    let mut folders: Vec<&str> = details[0].folders.iter().map(|f| f.name.as_str()).collect();
    folders.sort();
    assert_eq!(folders, ["发型", "姿势"]);

    let mut in_hair = browse(&library, BrowseScope::Folder { id: hair.clone() });
    in_hair.sort();
    let mut expected = ids[0..2].to_vec();
    expected.sort();
    assert_eq!(in_hair, expected);
    assert_eq!(
        browse(&library, BrowseScope::Folder { id: pose.clone() }),
        ids[0..1]
    );
    assert_eq!(browse(&library, BrowseScope::All).len(), 3);
    assert_eq!(tree(&library.sidebar().unwrap().folders), "发型(2) 姿势(1)");

    // 移出一个文件夹，另一个不受影响。放入两次也只算一次。
    let details = library
        .edit(
            &ids[0..1],
            &[
                ImageEdit::RemoveFromFolder {
                    folder_id: hair.clone(),
                },
                ImageEdit::AddToFolder {
                    folder_id: pose.clone(),
                },
            ],
        )
        .unwrap();
    let folders: Vec<&str> = details[0].folders.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(folders, ["姿势"]);
    assert_eq!(browse(&library, BrowseScope::Folder { id: hair }), ids[1..2]);
    assert_eq!(tree(&library.sidebar().unwrap().folders), "发型(1) 姿势(1)");
    assert_eq!(library.image(&ids[0]).unwrap(), details[0]);
}

#[test]
fn a_batch_edit_with_an_unknown_image_or_folder_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 2);
    let hair = library.create_folder("发型", None).unwrap();
    let add = [ImageEdit::AddToFolder {
        folder_id: hair.clone(),
    }];

    let with_unknown = [ids[0].clone(), "不存在".to_owned()];
    assert!(matches!(
        library.edit(&with_unknown, &add),
        Err(Error::UnknownImage)
    ));
    assert!(matches!(
        library.edit(
            &ids,
            &[
                ImageEdit::AddToFolder { folder_id: hair.clone() },
                ImageEdit::AddToFolder { folder_id: "不存在".into() },
            ]
        ),
        Err(Error::UnknownFolder)
    ));
    assert!(browse(&library, BrowseScope::Folder { id: hair }).is_empty());
}
