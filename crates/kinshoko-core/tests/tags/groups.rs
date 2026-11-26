use kinshoko_core::library::{TagEdit, TagNamespace};

use super::{add, library_with_images, named, tag_id};
use crate::legacy_tag_groups::insert_tag_group;

#[test]
fn tag_groups_list_their_tags_with_counts_in_the_interface_language() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 2);
    library
        .edit_tags(&ids, &[add("蓝发"), add("紫发")])
        .unwrap();
    library
        .edit_tags(
            &ids[..1],
            &[
                add("短发"),
                TagEdit::Add {
                    tag: named(TagNamespace::Work, "原创"),
                },
            ],
        )
        .unwrap();
    let blue = tag_id(&library, &ids[0], "蓝发");
    let purple = tag_id(&library, &ids[0], "紫发");
    library.rename_tag(&blue, "en", "blue hair").unwrap();

    insert_tag_group(&library, "发色", None, &[purple, blue]);
    insert_tag_group(&library, "作品", Some(TagNamespace::Work), &[]);

    let groups = library.tag_groups("en").unwrap();
    let shown: Vec<(&str, Vec<(&str, u32)>)> = groups
        .iter()
        .map(|g| {
            (
                g.name.as_str(),
                g.tags
                    .iter()
                    .map(|t| (t.tag.name.as_str(), t.count))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("发色", vec![("紫发", 2), ("blue hair", 2)]),
            ("作品", vec![("原创", 1)]),
        ]
    );
}
