//! 改了收进的库以后把旧库的订阅图移过去（#461）：没动过的图连同作者、来源与成人分级一起移到
//! 新库，旧库那张进回收站；画师整理过的、用在参考组里的、新库已有记录的作品留在原处；撤销后
//! 一切回到移之前。

use std::cell::RefCell;

use kinshoko_core::library::{
    BrowseQuery, BrowseScope, ContentRating, Error, ImageEdit, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};
use kinshoko_core::subscription::relocate::{self, OldImages};

use super::*;

impl relocate::Libraries for Libraries {
    fn with(
        &self,
        library_id: &str,
        f: &mut dyn FnMut(&Library) -> Result<(), Error>,
    ) -> Result<(), String> {
        let library = self
            .0
            .iter()
            .find(|l| l.info().id == library_id)
            .ok_or("没有这个资料库")?;
        f(library).map_err(|e| e.to_string())
    }
}

/// 参考组用到的图：（资料库，参考图）。
#[derive(Default)]
struct Groups(RefCell<Vec<(String, String)>>);

impl ReferenceGroupUsage for Groups {
    fn groups_using(
        &self,
        library_id: &str,
        image_ids: &[String],
    ) -> Result<Vec<GroupUsage>, GroupError> {
        let used: Vec<String> = image_ids
            .iter()
            .filter(|i| {
                self.0
                    .borrow()
                    .iter()
                    .any(|(l, g)| l == library_id && g == *i)
            })
            .cloned()
            .collect();
        Ok(if used.is_empty() {
            Vec::new()
        } else {
            vec![GroupUsage {
                group_id: "g".into(),
                name: "组".into(),
                image_ids: used,
            }]
        })
    }
}

/// 收了 `works` 再把订阅改到新建的第二个库。返回 (fixture, 旧库 id, 新库 id)。
fn collected_then_changed(works: Vec<Work>) -> (Fixture, String, String) {
    let mut f = Fixture::new();
    let mut source = FakeSource::with(works);
    f.check(&mut source).unwrap();
    let new = Library::create(&f._dir.path().join("lib2"), "新库").unwrap();
    new.set_safe_mode(false);
    let (old_id, new_id) = (f.library().info().id.clone(), new.info().id.clone());
    f.libraries.0.push(new);
    f.store
        .set_library(std::slice::from_ref(&f.subscription.id), &new_id)
        .unwrap();
    (f, old_id, new_id)
}

fn ids(f: &Fixture) -> Vec<String> {
    vec![f.subscription.id.clone()]
}

fn visible(library: &Library, scope: BrowseScope) -> usize {
    library
        .browse(&BrowseQuery {
            scope,
            conditions: Default::default(),
            cursor: None,
            limit: 1000,
            thumbnail_px: 64,
        })
        .unwrap()
        .cards
        .len()
}

fn image_of(f: &Fixture, library_id: &str) -> Vec<String> {
    f.store
        .previews(10)
        .unwrap()
        .into_iter()
        .flat_map(|p| p.images)
        .filter(|i| i.library_id == library_id)
        .map(|i| i.image_id)
        .collect()
}

#[test]
fn untouched_images_move_with_their_author_source_and_rating() {
    let (f, old_id, new_id) = collected_then_changed(vec![
        work("1", WorkKind::Illustration, true, 2),
        work("2", WorkKind::Illustration, false, 1),
    ]);
    let groups = Groups::default();
    assert_eq!(
        relocate::old_images(&f.store, &f.libraries, &groups, &ids(&f)).unwrap(),
        [OldImages {
            subscription_id: f.subscription.id.clone(),
            library_id: old_id.clone(),
            movable: 3,
            kept: 0,
        }]
    );

    let report = relocate::move_old(&f.store, &f.libraries, &groups, &ids(&f)).unwrap();
    assert_eq!((report.moved, report.kept), (3, 0));
    let new = &f.libraries.0[1];
    assert_eq!(visible(new, BrowseScope::All), 3);
    assert_eq!(visible(f.library(), BrowseScope::All), 0);
    assert_eq!(visible(f.library(), BrowseScope::Trash), 3);
    assert!(
        relocate::old_images(&f.store, &f.libraries, &groups, &ids(&f))
            .unwrap()
            .is_empty()
    );

    // 新库的图带着作者、来源链接与成人分级。
    let moved = image_of(&f, &new_id);
    assert_eq!(moved.len(), 2);
    let adult = report
        .works
        .iter()
        .find(|w| w.work_id == "1")
        .unwrap()
        .pages[0]
        .to_image_id
        .clone();
    let detail = new.image(&adult).unwrap();
    assert_eq!(detail.source_links, ["https://www.pixiv.net/artworks/1"]);
    assert_eq!(detail.rating.effective, Some(ContentRating::Explicit));
    let tags = new.image_tags(&adult, "zh-CN").unwrap();
    assert!(
        tags.tags
            .iter()
            .any(|t| t.tag.namespace == TagNamespace::Artist && t.tag.name == "某画师")
    );
    // 改库前收过的作品，之后检查不再收第二份。
    let mut again = FakeSource::with(vec![work("1", WorkKind::Illustration, true, 2)]);
    f.check(&mut again).unwrap();
    assert!(again.downloads.is_empty());
}

#[test]
fn undo_puts_everything_back() {
    let (f, old_id, _) = collected_then_changed(vec![work("1", WorkKind::Illustration, false, 1)]);
    let groups = Groups::default();
    let report = relocate::move_old(&f.store, &f.libraries, &groups, &ids(&f)).unwrap();
    relocate::undo_move(&f.store, &f.libraries, &report.works).unwrap();
    assert_eq!(visible(f.library(), BrowseScope::All), 1);
    assert_eq!(visible(&f.libraries.0[1], BrowseScope::All), 0);
    assert_eq!(image_of(&f, &old_id).len(), 1);
    assert_eq!(
        relocate::old_images(&f.store, &f.libraries, &groups, &ids(&f)).unwrap()[0].movable,
        1
    );
}

#[test]
fn organized_images_stay_and_keep_their_whole_work() {
    let (f, old_id, _) = collected_then_changed(vec![
        work("1", WorkKind::Illustration, false, 2),
        work("2", WorkKind::Illustration, false, 1),
        work("3", WorkKind::Illustration, false, 1),
        work("4", WorkKind::Illustration, false, 1),
    ]);
    let old = f.library();
    let page_image = |work: &str| {
        old.browse(&BrowseQuery {
            scope: BrowseScope::All,
            conditions: Default::default(),
            cursor: None,
            limit: 1000,
            thumbnail_px: 64,
        })
        .unwrap()
        .cards
        .into_iter()
        .map(|c| c.id)
        .find(|id| {
            old.image(id)
                .unwrap()
                .source_links
                .contains(&format!("https://www.pixiv.net/artworks/{work}"))
        })
        .unwrap()
    };
    // 作品 1 的一页加了标签：整个作品留下。作品 2 写了备注，作品 3 用在参考组里。
    old.edit_tags(
        &[page_image("1")],
        &[TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::General,
                name: "手".into(),
                lang: "zh-CN".into(),
            },
        }],
    )
    .unwrap();
    old.edit(
        &[page_image("2")],
        &[ImageEdit::SetNote {
            text: "构图".into(),
        }],
    )
    .unwrap();
    let groups = Groups::default();
    groups
        .0
        .borrow_mut()
        .push((old_id.clone(), page_image("3")));

    let report = relocate::move_old(&f.store, &f.libraries, &groups, &ids(&f)).unwrap();
    assert_eq!((report.moved, report.kept), (1, 4));
    assert_eq!(visible(old, BrowseScope::All), 4);
    assert_eq!(visible(&f.libraries.0[1], BrowseScope::All), 1);
}

#[test]
fn a_work_the_new_library_already_has_stays() {
    let (f, _, new_id) = collected_then_changed(vec![work("1", WorkKind::Illustration, false, 1)]);
    // 新库里亲手收过同一个作品。
    let mut source = FakeSource::with(vec![work("1", WorkKind::Illustration, false, 1)]);
    let report = kinshoko_core::subscription::collect_by_hand(
        &f.store,
        SourceId::Pixiv,
        &new_id,
        &work("1", WorkKind::Illustration, false, 1),
        None,
        true,
        &mut |url| source.download(url),
        &f.libraries,
        &|| 9_000,
        &AtomicBool::new(false),
    )
    .unwrap();
    let _ = report;
    let report = relocate::move_old(&f.store, &f.libraries, &Groups::default(), &ids(&f)).unwrap();
    assert_eq!((report.moved, report.kept), (0, 1));
    assert_eq!(visible(f.library(), BrowseScope::All), 1);
}

#[test]
fn sealed_images_move_while_safe_mode_is_on() {
    let (f, _, _) = collected_then_changed(vec![work("1", WorkKind::Illustration, true, 1)]);
    for library in &f.libraries.0 {
        library.set_safe_mode(true);
    }
    let report = relocate::move_old(&f.store, &f.libraries, &Groups::default(), &ids(&f)).unwrap();
    assert_eq!((report.moved, report.kept), (1, 0));
    relocate::undo_move(&f.store, &f.libraries, &report.works).unwrap();
    f.library().set_safe_mode(false);
    assert_eq!(visible(f.library(), BrowseScope::All), 1);
}
