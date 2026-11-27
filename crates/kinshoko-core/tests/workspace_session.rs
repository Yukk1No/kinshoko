//! 工作区会话与可见性许可（#749）：锁外准备 → 进门复核 → 门内生效，以及固定的取锁顺序。
//! 只经 `WorkspaceSession` 的对外接口，用临时目录里的真 SQLite 与真文件，不启动应用。

use std::sync::atomic::{AtomicBool, Ordering};
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
use kinshoko_core::{CommandError, Library, PublicationGate, VisibilityPermit, WorkspaceSession};

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

#[cfg(debug_assertions)]
fn assert_lock_order_violation(action: impl FnOnce()) {
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action))
        .expect_err("expected a lock-order panic");
    assert!(
        panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .is_some_and(|message| message.contains("取锁顺序")),
        "{panic:?}"
    );
}

#[cfg(debug_assertions)]
#[test]
fn transition_cannot_reenter() {
    let f = Fixture::new(true);
    let _transition = f.session.transition();
    assert_lock_order_violation(|| drop(f.session.transition()));
}

#[cfg(debug_assertions)]
#[test]
fn libraries_cannot_reenter_or_wait_for_an_earlier_lock() {
    let f = Fixture::new(true);
    let _libraries = f.session.lock_libraries();
    assert_lock_order_violation(|| drop(f.session.transition()));
    assert_lock_order_violation(|| drop(f.session.lock_libraries()));
    let gate = f.session.tagging_publication_gate();
    assert_lock_order_violation(|| drop(gate.lock()));
    assert_lock_order_violation(|| drop(gate.lock_unless_cancelled(&AtomicBool::new(false))));
}

#[cfg(debug_assertions)]
#[test]
fn catalog_cannot_reenter_or_wait_for_an_earlier_lock() {
    let f = Fixture::new(true);
    f.session
        .with_catalog(|_| {
            assert_lock_order_violation(|| drop(f.session.transition()));
            assert_lock_order_violation(|| drop(f.session.visibility()));
            assert_lock_order_violation(|| drop(f.session.lock_libraries()));
            assert_lock_order_violation(|| f.session.with_catalog(|_| Ok(())).unwrap());
            Ok(())
        })
        .unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn workspace_cannot_reenter_or_wait_for_an_earlier_lock() {
    let f = Fixture::new(true);
    f.session
        .with_resources(|_, _, _| {
            assert_lock_order_violation(|| drop(f.session.transition()));
            assert_lock_order_violation(|| drop(f.session.visibility()));
            assert_lock_order_violation(|| drop(f.session.lock_libraries()));
            assert_lock_order_violation(|| f.session.with_catalog(|_| Ok(())).unwrap());
            assert_lock_order_violation(|| f.session.reset_workspace());
            Ok(())
        })
        .unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn publication_gate_counts_as_a_permit() {
    let f = Fixture::new(true);
    let gate = f.session.tagging_publication_gate();
    let _publication = gate.lock();
    assert_lock_order_violation(|| drop(f.session.transition()));
    assert_lock_order_violation(|| drop(f.session.visibility()));
}

#[test]
fn libraries_can_be_read_for_logging_without_waiting_under_resources() {
    let f = Fixture::new(true);
    let library = f.library("a");
    f.session
        .with_catalog(|_| {
            let id = f
                .session
                .try_with_libraries(|libraries| libraries.unwrap().libraries()[0].id.clone());
            assert_eq!(id.as_deref(), Some(library.info().id.as_str()));
            Ok(())
        })
        .unwrap();
    f.session
        .with_resources(|_, _, _| {
            assert_eq!(f.session.try_with_libraries(|_| ()), None);
            Ok(())
        })
        .unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn a_successful_try_libraries_tracks_the_lock_inside_its_callback() {
    let f = Fixture::new(true);
    assert_eq!(
        f.session.try_with_libraries(|_| {
            assert_lock_order_violation(|| drop(f.session.transition()));
            assert_lock_order_violation(|| drop(f.session.visibility()));
            assert_lock_order_violation(|| drop(f.session.lock_libraries()));
        }),
        Some(())
    );
    f.session.with_visibility(|_| ());
}

#[test]
fn the_publication_gate_waits_for_the_visibility_permit() {
    let f = Fixture::new(true);
    let permit = f.session.visibility();
    let gate = f.session.tagging_publication_gate();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (entered_tx, entered_rx) = mpsc::channel();
    // Move the permit into the scope so it is released before joining on failure, too.
    std::thread::scope(|scope| {
        let permit = permit;
        scope.spawn(move || {
            ready_tx.send(()).unwrap();
            let _publication = gate.lock();
            entered_tx.send(()).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        drop(permit);
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
}

#[test]
fn waiting_for_publication_can_be_cancelled_before_the_gate_opens() {
    let gate = PublicationGate::default();
    let cancel = AtomicBool::new(false);
    let (ready_tx, ready_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let publication = gate.lock();
        let cancel = &cancel;
        let gate = &gate;
        scope.spawn(move || {
            ready_tx.send(()).unwrap();
            result_tx
                .send(gate.lock_unless_cancelled(cancel).is_none())
                .unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            result_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        cancel.store(true, Ordering::SeqCst);
        assert!(result_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        drop(publication);
    });
    assert!(gate.lock_unless_cancelled(&cancel).is_none());
    cancel.store(false, Ordering::SeqCst);
    assert!(gate.lock_unless_cancelled(&cancel).is_some());
}

#[test]
fn transition_commit_waits_for_a_transition_and_holds_the_registry_during_the_action() {
    let f = Fixture::new(true);
    let session = &f.session;
    let (ready_tx, ready_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let transition = session.transition();
        scope.spawn(move || {
            ready_tx.send(()).unwrap();
            let result = session.with_transition_commit(
                |libraries| {
                    assert!(libraries.libraries().is_empty());
                    assert_eq!(session.try_with_libraries(|_| ()), None);
                    Ok(7)
                },
                |value| {
                    #[cfg(debug_assertions)]
                    assert_lock_order_violation(|| drop(session.transition()));
                    let _permit = session.visibility();
                    session.with_libraries(|_| Ok(value))
                },
            );
            done_tx.send(result).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        // Dropping the transition lets the action reach the next lock, which we still hold.
        let publication = session.tagging_publication_gate();
        let publication = publication.lock();
        drop(transition);
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(publication);
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            7
        );
    });
}

fn stale_for_capture(_: LensStale) -> CommandError {
    CommandError::new(ErrorKind::CaptureSafeModeChanged, "safe mode changed")
}

#[test]
fn current_lens_supplies_the_saved_switch_and_maps_a_generation_change() {
    let f = Fixture::new(false);
    let session = &f.session;
    let stale_for_mapping =
        |_| CommandError::new(ErrorKind::TagMappingSafeModeChanged, "safe mode changed");
    assert!(
        !session
            .with_current_lens(stale_for_mapping, |_, _, _, on| Ok(on))
            .unwrap()
    );

    let (read_tx, read_rx) = mpsc::channel();
    let (changed_tx, changed_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            read_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            // A generation can change without needing to take the registry lock.
            session
                .visibility()
                .replace_safe_mode(SafeMode::new(true, SafeModeScope::Explicit));
            changed_tx.send(()).unwrap();
        });
        let error = session
            .with_current_lens(stale_for_mapping, |_, _, _, on| {
                assert!(!on);
                read_tx.send(()).unwrap();
                changed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::TagMappingSafeModeChanged);
    });
    assert!(
        session
            .with_current_lens(stale_for_mapping, |_, _, _, on| Ok(on))
            .unwrap()
    );
}

#[test]
fn checking_and_committing_grants_honors_both_generations() {
    let f = Fixture::new(true);
    let session = &f.session;
    let grant = session.grant();
    let preview = session.import_preview_grant().unwrap();
    assert!(session.is_grant_current(&grant));
    assert!(session.is_grant_current(&preview));
    let result = VisibilityPermit::commit_grant(session, &preview, stale_for_capture, |permit| {
        assert_eq!(permit.confirm(&preview), Ok(()));
        Ok(7)
    });
    assert_eq!(result.unwrap(), 7);

    session.fence_import_preview();
    assert!(session.is_grant_current(&grant));
    assert!(!session.is_grant_current(&preview));
    let check_rejected = |grant| {
        let result = VisibilityPermit::commit_grant(session, grant, stale_for_capture, |_| {
            panic!("a stale grant must not apply")
        });
        let result: Result<(), _> = result;
        assert_eq!(result.unwrap_err().kind, ErrorKind::CaptureSafeModeChanged);
    };
    check_rejected(&preview);

    f.commit(|mode| mode.on = true);
    assert!(!session.is_grant_current(&grant));
    check_rejected(&grant);
}
