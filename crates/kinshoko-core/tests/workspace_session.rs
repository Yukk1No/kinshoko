//! 工作区会话与可见性许可（#749）：锁外准备 → 进门复核 → 门内生效，以及固定的取锁顺序。
//! 只经 `WorkspaceSession` 的对外接口，用临时目录里的真 SQLite 与真文件，不启动应用。

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use image::{Rgba, RgbaImage};
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::library::{
    ContentRating, ImageEdit, ImportSource, SafeMode, SafeModeScope, TagTranslations,
};
use kinshoko_core::safe_mode::LensStale;
use kinshoko_core::search::CatalogSearch;
use kinshoko_core::session::Hold;
use kinshoko_core::{CommandError, Library, VisibilityPermit, WorkspaceSession};

struct Fixture {
    dir: tempfile::TempDir,
    session: Arc<WorkspaceSession>,
}

impl Fixture {
    fn new(on: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        let search = CatalogSearch::new(
            app.clone(),
            TagTranslations::default(),
            BuiltinApproxTable::bundled(),
        );
        let session =
            WorkspaceSession::new(app, SafeMode::new(on, SafeModeScope::Explicit), search);
        Self {
            dir,
            session: Arc::new(session),
        }
    }

    fn library(&self, name: &str) -> Arc<Library> {
        let root = self.dir.path().join(name);
        let library = self
            .session
            .with_libraries(|device| device.create(&root, name))
            .unwrap();
        self.session.configure_library(&library);
        library
    }

    fn import(&self, library: &Library, red: u8) -> String {
        let path = self.dir.path().join(format!("{red}.png"));
        RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
            .save(&path)
            .unwrap();
        library
            .import(ImportSource { paths: vec![path] })
            .wait()
            .items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned()
    }

    /// 在可见性许可里提交一次安全模式改动，保存总是成功。
    fn commit(&self, change: impl FnOnce(&mut SafeMode)) {
        self.session
            .visibility()
            .try_commit_safe_mode(change, |_| Ok::<_, ()>(()))
            .unwrap();
    }
}

fn rate(library: &Library, id: &str, rating: ContentRating) {
    library.set_safe_mode(false);
    library
        .edit(&[id.to_owned()], &[ImageEdit::SetRating { rating }])
        .unwrap();
}

#[test]
fn tightening_safe_mode_while_preparing_blocks_the_apply() {
    let f = Fixture::new(false);
    let applied = AtomicBool::new(false);
    let result = VisibilityPermit::commit(
        &f.session,
        |grant| {
            assert!(!grant.on());
            // 准备在门外：这里能进门提交，否则会因为重入许可而 panic。
            f.commit(|mode| mode.on = true);
            Ok::<_, LensStale>("解码好的像素")
        },
        |_, _| {
            applied.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result, Err(LensStale));
    assert!(!applied.load(Ordering::SeqCst), "切紧之后仍在门内生效了");
    assert!(f.session.safe_mode().current().on);
}

#[test]
fn committing_the_same_value_while_preparing_still_blocks_the_apply() {
    let f = Fixture::new(true);
    let result = VisibilityPermit::commit(
        &f.session,
        |_| {
            f.commit(|mode| mode.on = true);
            Ok::<_, LensStale>(())
        },
        |_, ()| -> Result<(), LensStale> { panic!("提交过安全模式，不该生效") },
    );
    assert_eq!(result, Err(LensStale));
}

#[test]
fn an_unchanged_grant_applies_inside_the_permit() {
    let f = Fixture::new(true);
    let generation = f.session.safe_mode().snapshot();
    let result = VisibilityPermit::commit(
        &f.session,
        |grant| Ok::<_, LensStale>(grant.on()),
        |permit, on| {
            assert_eq!(permit.generation(), generation);
            Ok(on)
        },
    );
    assert_eq!(result, Ok(true));
}

#[test]
fn a_failed_save_keeps_the_setting_and_still_revokes_grants() {
    let f = Fixture::new(true);
    let grant = f.session.grant();
    let saved: Result<(), &str> = f
        .session
        .visibility()
        .try_commit_safe_mode(|mode| mode.on = false, |_| Err("磁盘满了"));
    assert_eq!(saved, Err("磁盘满了"));
    assert!(f.session.safe_mode().current().on, "保存不成，设置不变");
    assert_eq!(f.session.visibility().confirm(&grant), Err(LensStale));
}

#[test]
fn a_rating_that_seals_the_image_while_preparing_blocks_the_apply() {
    // 安全模式没有提交过，但图在准备期间被评进了范围：进门后重新核对可见性才能拦住。
    let f = Fixture::new(true);
    let a = f.library("a");
    let image = f.import(&a, 10);
    let id = a.info().id.clone();
    let result = VisibilityPermit::commit_image(
        &f.session,
        &id,
        &image,
        |library| {
            let detail = library.image(&image).map_err(CommandError::from)?;
            rate(&a, &image, ContentRating::Explicit);
            Ok::<_, CommandError>(detail)
        },
        |_, _| -> Result<(), CommandError> { panic!("封印图在门内生效了") },
    );
    assert_eq!(result.unwrap_err().kind, ErrorKind::UnknownImage);
}

#[test]
fn a_visible_image_applies_and_a_sealed_one_is_never_prepared() {
    let f = Fixture::new(true);
    let a = f.library("a");
    let shown = f.import(&a, 10);
    let sealed = f.import(&a, 20);
    rate(&a, &sealed, ContentRating::Explicit);
    let id = a.info().id.clone();

    let applied = VisibilityPermit::commit_image(
        &f.session,
        &id,
        &shown,
        |library| Ok::<_, CommandError>(library.info().id.clone()),
        |_, library_id| Ok(library_id),
    );
    assert_eq!(applied.unwrap(), id);

    let result = VisibilityPermit::commit_image(
        &f.session,
        &id,
        &sealed,
        |_| -> Result<(), CommandError> { panic!("封印图不该被准备") },
        |_, ()| Ok(()),
    );
    assert_eq!(result.unwrap_err().kind, ErrorKind::UnknownImage);
}

#[test]
fn a_safe_mode_commit_waits_until_the_apply_leaves_the_permit() {
    let f = Fixture::new(false);
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    let (committed_tx, committed) = mpsc::channel();
    let session = &f.session;
    std::thread::scope(|scope| {
        scope.spawn(move || {
            VisibilityPermit::commit(
                session,
                |_| Ok::<_, LensStale>(()),
                |_, ()| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                },
            )
            .unwrap();
        });
        entered.recv().unwrap();
        let committed_tx = committed_tx.clone();
        scope.spawn(move || {
            session
                .visibility()
                .try_commit_safe_mode(|mode| mode.on = true, |_| Ok::<_, ()>(()))
                .unwrap();
            committed_tx.send(()).unwrap();
        });
        assert_eq!(
            committed.recv_timeout(Duration::from_millis(200)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "门内生效期间安全模式提交了"
        );
        assert!(!f.session.safe_mode().current().on);
        release.send(()).unwrap();
        committed.recv().unwrap();
    });
    assert!(f.session.safe_mode().current().on);
}

#[test]
fn no_chunk_is_sent_after_safe_mode_is_committed() {
    let f = Fixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let committed = AtomicBool::new(false);
    let chunks = AtomicUsize::new(0);
    let (first_tx, first) = mpsc::channel();
    let result = std::thread::scope(|scope| {
        let session = &f.session;
        let committed = &committed;
        scope.spawn(move || {
            first.recv().unwrap();
            let permit = session.visibility();
            permit
                .try_commit_safe_mode(|mode| mode.on = true, |_| Ok::<_, ()>(()))
                .unwrap();
            committed.store(true, Ordering::SeqCst);
        });
        VisibilityPermit::stream(&f.session, grant, |_| {
            assert!(!committed.load(Ordering::SeqCst), "提交之后又发送了一块");
            if chunks.fetch_add(1, Ordering::SeqCst) == 0 {
                first_tx.send(()).unwrap();
            }
            // 块与块之间出门：等着的提交迟早能进门，流随即停下。
            Ok::<_, LensStale>(ControlFlow::Continue(()))
        })
    });
    assert_eq!(result, Err::<(), _>(LensStale));
    assert!(chunks.load(Ordering::SeqCst) >= 1);
}

#[test]
fn a_fence_without_the_permit_stops_the_next_chunk() {
    let f = Fixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let mut chunks = 0;
    let result = VisibilityPermit::stream(&f.session, grant, |_| {
        chunks += 1;
        // 窗口线程不能等许可，只让导入预览代次前进。
        f.session.fence_import_preview();
        Ok::<_, LensStale>(ControlFlow::Continue(()))
    });
    assert_eq!(result, Err::<(), _>(LensStale));
    assert_eq!(chunks, 1);
}

#[test]
fn a_stream_ends_when_the_last_chunk_is_sent() {
    let f = Fixture::new(true);
    let grant = f.session.import_preview_grant().unwrap();
    let mut sent = Vec::new();
    let result = VisibilityPermit::stream(&f.session, grant, |_| {
        sent.push(sent.len());
        Ok::<_, LensStale>(if sent.len() == 3 {
            ControlFlow::Break("完")
        } else {
            ControlFlow::Continue(())
        })
    });
    assert_eq!(result, Ok("完"));
    assert_eq!(sent, [0, 1, 2]);
}

#[test]
fn import_preview_grants_need_safe_mode_on() {
    assert_eq!(
        Fixture::new(false).session.import_preview_grant(),
        Err(LensStale)
    );
}

#[test]
fn lens_holds_reject_a_mismatched_switch() {
    let f = Fixture::new(true);
    let _a = f.library("a");
    let mismatched = f.session.with_lens(false, Hold::Read, |_, _, _| Ok(()));
    assert_eq!(mismatched.unwrap_err().kind, ErrorKind::LensChanged);

    let confirmed = f.session.with_lens(true, Hold::Confirmed, |_, _, _| Ok(7));
    assert_eq!(confirmed.unwrap(), 7);

    let status = f
        .session
        .with_lens(true, Hold::Commit, |w, d, c| w.status(d, c, true));
    assert!(status.is_ok(), "{status:?}");
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "取锁顺序")]
fn waiting_for_the_transition_inside_the_permit_panics() {
    let f = Fixture::new(true);
    let _permit = f.session.visibility();
    let _transition = f.session.transition();
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "取锁顺序")]
fn entering_the_permit_while_holding_resources_panics() {
    let f = Fixture::new(true);
    let _ = f.session.with_libraries(|_| {
        let _permit = f.session.visibility();
        Ok(())
    });
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "取锁顺序")]
fn reentering_the_permit_panics() {
    let f = Fixture::new(true);
    f.session.with_visibility(|_| {
        let _again = f.session.visibility();
    });
}

/// 一份几千字节的 PNG（像素不规则，压不小），分好几块才发完。
fn noisy_png(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("noisy.png");
    let mut seed = 0x2545_f491_u32;
    RgbaImage::from_fn(40, 40, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let [r, g, b, _] = seed.to_le_bytes();
        Rgba([r, g, b, 255])
    })
    .save(&path)
    .unwrap();
    path
}

/// 安全模式开启时，把一份已在别的库评为成人的图导入 `target`：回执里它被封印，只能经预览显示。
/// 返回打开的预览、要读的项与原图字节。
fn sealed_duplicate_preview(f: &Fixture) -> (String, String, Vec<u8>) {
    use kinshoko_core::library::{ImportOptions, SaveDestination};
    let adult = f.library("adult");
    let target = f.library("target");
    let same = noisy_png(f.dir.path());
    let adult_image = adult
        .import(ImportSource {
            paths: vec![same.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    rate(&adult, &adult_image, ContentRating::Explicit);
    let target_id = target.info().id.clone();
    let task = f
        .session
        .with_libraries(|device| {
            device.start_import_to(
                SaveDestination {
                    library_id: target_id.clone(),
                    folder_id: None,
                },
                ImportSource {
                    paths: vec![same.clone()],
                },
                ImportOptions::default(),
            )
        })
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while f
        .session
        .with_libraries(|device| Ok(device.import_task(&task).unwrap().report.is_none()))
        .unwrap()
    {
        assert!(std::time::Instant::now() < deadline, "导入没有收尾");
        std::thread::sleep(Duration::from_millis(5));
    }
    let grant = f.session.begin_import_preview().unwrap();
    let preview = f
        .session
        .open_import_preview(grant, &target_id, &task)
        .unwrap();
    let bytes = std::fs::read(&same).unwrap();
    assert!(bytes.len() > 3 * kinshoko_core::session::IMPORT_PREVIEW_CHUNK_BYTES);
    (preview.id, preview.items[0].clone(), bytes)
}

#[test]
fn an_import_preview_sends_the_original_bytes_in_chunks() {
    let f = Fixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let mut chunks = Vec::new();
    f.session
        .read_import_preview(
            f.session.import_preview_grant().unwrap(),
            &preview,
            &item,
            240,
            |chunk| {
                chunks.push(chunk.to_vec());
                Ok(())
            },
        )
        .unwrap();
    assert!(chunks.len() > 3, "{} 块", chunks.len());
    assert_eq!(chunks.concat(), bytes);
}

#[test]
fn an_import_preview_stops_sending_once_safe_mode_is_committed() {
    let f = Fixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let committed = AtomicBool::new(false);
    let mut sent = 0;
    let (first_tx, first) = mpsc::channel();
    let result = std::thread::scope(|scope| {
        let session = &f.session;
        let committed = &committed;
        scope.spawn(move || {
            first.recv().unwrap();
            let permit = session.visibility();
            permit
                .try_commit_safe_mode(|mode| mode.on = true, |_| Ok::<_, ()>(()))
                .unwrap();
            committed.store(true, Ordering::SeqCst);
        });
        f.session.read_import_preview(
            f.session.import_preview_grant().unwrap(),
            &preview,
            &item,
            240,
            |chunk| {
                assert!(
                    !committed.load(Ordering::SeqCst),
                    "提交之后又发送了预览字节"
                );
                if sent == 0 {
                    first_tx.send(()).unwrap();
                }
                sent += chunk.len();
                Ok(())
            },
        )
    });
    // 提交不一定赶在最后一块之前进门；赶上了就必须停下，不再发送。
    match result {
        Ok(()) => assert_eq!(sent, bytes.len()),
        Err(error) => {
            assert_eq!(error.kind, ErrorKind::LensChanged);
            assert!(sent < bytes.len());
        }
    }
    let after = f.session.read_import_preview(
        f.session.import_preview_grant().unwrap(),
        &preview,
        &item,
        240,
        |_| panic!("安全模式提交后预览同意已作废"),
    );
    assert!(after.is_err());
}

#[test]
fn closing_the_window_fences_an_import_preview_before_the_next_chunk() {
    let f = Fixture::new(true);
    let (preview, item, bytes) = sealed_duplicate_preview(&f);
    let mut sent = 0;
    let result = f.session.read_import_preview(
        f.session.import_preview_grant().unwrap(),
        &preview,
        &item,
        240,
        |chunk| {
            sent += chunk.len();
            // 窗口线程不等许可，只让导入预览代次前进。
            f.session.fence_import_preview();
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().kind, ErrorKind::LensChanged);
    assert_eq!(sent, kinshoko_core::session::IMPORT_PREVIEW_CHUNK_BYTES);
    assert!(sent < bytes.len());
}
