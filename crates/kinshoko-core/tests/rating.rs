//! 人工分级（#53）：画师修正内容分级，人工分级优先于自动分级，重新打标不覆盖；
//! 退回后重新显示自动分级。资料库用临时目录里的真库。

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, FactSource, ImageEdit, ImageRating, ImportOutcome, ImportSource, RatingFact,
};

fn library_with_images(n: u8) -> (tempfile::TempDir, Library, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let paths = (0..n)
        .map(|i| {
            let path = dir.path().join(format!("{i}.png"));
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    let ids = library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    (dir, library, ids)
}

fn model() -> FactSource {
    FactSource::model("pixai-tagger-v1.0")
}

fn suggest(library: &Library, id: &str, rating: ContentRating) {
    library
        .replace_source_rating(
            &model(),
            id,
            Some(RatingFact {
                rating,
                score: Some(0.8),
            }),
        )
        .unwrap();
}

#[test]
fn a_manual_rating_wins_over_the_model_and_survives_retagging() {
    let (_dir, library, ids) = library_with_images(1);
    let id = &ids[0];
    suggest(&library, id, ContentRating::Explicit);

    let details = library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::General,
            }],
        )
        .unwrap();
    let expected = ImageRating {
        image_id: id.clone(),
        suggested: Some(ContentRating::Explicit),
        manual: Some(ContentRating::General),
        effective: Some(ContentRating::General),
    };
    assert_eq!(details[0].rating, expected, "编辑返回的详情带分级");

    // 重新打标：模型来源整层重写，人工分级不动。
    suggest(&library, id, ContentRating::Questionable);
    let rating = library.image_rating(id).unwrap();
    assert_eq!(rating.suggested, Some(ContentRating::Questionable));
    assert_eq!(rating.manual, Some(ContentRating::General));
    assert_eq!(rating.effective, Some(ContentRating::General));
    assert_eq!(library.image(id).unwrap().rating, rating);
}

#[test]
fn reverting_the_manual_rating_shows_the_model_rating_again() {
    let (_dir, library, ids) = library_with_images(1);
    let id = &ids[0];
    suggest(&library, id, ContentRating::Sensitive);
    library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();

    let details = library.edit(&ids, &[ImageEdit::RevertRating]).unwrap();
    assert_eq!(
        details[0].rating,
        ImageRating {
            image_id: id.clone(),
            suggested: Some(ContentRating::Sensitive),
            manual: None,
            effective: Some(ContentRating::Sensitive),
        }
    );
}

#[test]
fn an_image_without_a_model_rating_can_be_rated_by_hand_in_bulk() {
    let (_dir, library, ids) = library_with_images(2);
    assert_eq!(library.image_rating(&ids[0]).unwrap().effective, None);

    library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::Questionable,
            }],
        )
        .unwrap();
    for id in &ids {
        let rating = library.image_rating(id).unwrap();
        assert_eq!(rating.suggested, None);
        assert_eq!(rating.effective, Some(ContentRating::Questionable));
    }
}

#[test]
fn the_manual_rating_is_kept_after_reopening() {
    let (dir, library, ids) = library_with_images(1);
    library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::Sensitive,
            }],
        )
        .unwrap();
    drop(library);
    let library = Library::open(&dir.path().join("lib")).unwrap();
    assert_eq!(
        library.image_rating(&ids[0]).unwrap().manual,
        Some(ContentRating::Sensitive)
    );
}
