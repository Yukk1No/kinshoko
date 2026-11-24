//! 撤销删除文件夹（#478）。

use kinshoko_core::library::{BrowseScope, ImageEdit};

use super::organize::{browse, library_with, tree};

/// 撤销删除文件夹（#478）：名称、位置、子文件夹、成员、同级顺序都回到删除前。
#[test]
fn undoing_a_folder_delete_restores_the_tree_and_every_membership() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 3);
    let a = library.create_folder("甲", None).unwrap();
    let people = library.create_folder("人物", None).unwrap();
    let c = library.create_folder("丙", None).unwrap();
    let hands = library.create_folder("手部", Some(&people)).unwrap();
    let _faces = library.create_folder("脸", Some(&people)).unwrap();
    library
        .edit(
            &[ids[0].clone(), ids[1].clone()],
            &[ImageEdit::AddToFolder {
                folder_id: people.clone(),
            }],
        )
        .unwrap();
    library
        .edit(
            &[ids[1].clone(), ids[2].clone()],
            &[ImageEdit::AddToFolder {
                folder_id: hands.clone(),
            }],
        )
        .unwrap();
    let before = tree(&library.sidebar().unwrap().folders);
    let people_before = browse(&library, BrowseScope::Folder { id: people.clone() });
    let hands_before = browse(&library, BrowseScope::Folder { id: hands.clone() });

    let deleted = library.delete_folder(&people).unwrap();
    assert_eq!(tree(&library.sidebar().unwrap().folders), "甲(0) 丙(0)");
    // 快照经前端往返（序列化）后照样能放回。
    let deleted = serde_json::from_str(&serde_json::to_string(&deleted).unwrap()).unwrap();
    library.restore_folder(deleted).unwrap();

    assert_eq!(tree(&library.sidebar().unwrap().folders), before);
    assert_eq!(
        browse(&library, BrowseScope::Folder { id: people }),
        people_before
    );
    assert_eq!(
        browse(&library, BrowseScope::Folder { id: hands }),
        hands_before
    );
    let _ = (a, c);
}

/// 子文件夹被单独撤销时，原来的上级若已不在，放到顶层；放回后可以照常再删。
#[test]
fn undoing_a_delete_whose_parent_is_gone_puts_it_at_the_top() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _) = library_with(dir.path(), 0);
    let parent = library.create_folder("人物", None).unwrap();
    let child = library.create_folder("手部", Some(&parent)).unwrap();
    let deleted = library.delete_folder(&child).unwrap();
    library.delete_folder(&parent).unwrap();
    library.restore_folder(deleted).unwrap();
    assert_eq!(tree(&library.sidebar().unwrap().folders), "手部(0)");
    library.delete_folder(&child).unwrap();
}
