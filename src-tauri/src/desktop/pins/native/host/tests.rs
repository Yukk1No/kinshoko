use std::process::Command;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use kinshoko_core::desktop::{PinContent, Placement, SavedPin};
use tauri::test::{mock_context, noop_assets};

use super::*;
use crate::desktop::pins::native::render::Notify;
use crate::desktop::pins::native::{Frame, Look};

const CHILD_ENV: &str = "KINSHOKO_NATIVE_EXIT_CHILD";
const TEST: &str =
    "desktop::pins::native::host::tests::native_pins_are_disposed_before_process_exit";

#[test]
fn native_pins_are_disposed_before_process_exit() {
    if let Ok(mode) = std::env::var(CHILD_ENV) {
        child(&mode);
    }
    for mode in ["loading", "pin", "empty"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD_ENV, mode)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(0), "{mode}: {stderr}");
        assert!(
            !stderr.contains("cannot access a Thread Local Storage value"),
            "{stderr}"
        );
        assert!(
            !stderr.contains("threads should not terminate unexpectedly"),
            "{stderr}"
        );
    }
}

struct OnShellDrop {
    notify: Arc<Notify>,
    done: mpsc::Sender<usize>,
}

impl Drop for OnShellDrop {
    fn drop(&mut self) {
        let _ = self.done.send(Arc::strong_count(&self.notify));
    }
}

fn child(mode: &str) -> ! {
    let app = tauri::Builder::default()
        .any_thread()
        .build(mock_context(noop_assets()))
        .unwrap();
    let (shell_dropped, dropped) = mpsc::channel();
    let (started, reading) = mpsc::channel();
    let (release, blocked) = mpsc::channel::<()>();
    let blocked = Mutex::new(blocked);
    let loading = mode == "loading";
    let notify: Arc<Notify> = Arc::new(|_| {});
    if mode != "empty" {
        NATIVE.with(|slot| assert!(slot.borrow().is_none()));
        let probe = OnShellDrop {
            notify: notify.clone(),
            done: shell_dropped,
        };
        let shell = WinShell::new(move || {
            let _ = &probe;
        })
        .unwrap();
        let render = RenderThread::start(
            Arc::new(move |_, _| {
                if loading {
                    started.send(()).unwrap();
                    let _ = blocked.lock().unwrap().recv();
                }
                Err("unused".into())
            }),
            notify.clone(),
        );
        let mut native = Orchestra::new(shell, render);
        let pin = SavedPin {
            id: "exit-test".into(),
            content: PinContent::Capture {
                capture_id: "unused".into(),
            },
            crop: None,
            width: 16,
            height: 16,
            placement: Placement {
                x: -30_000,
                y: -30_000,
                ..Placement::default()
            },
            opacity: 1.0,
            locked: false,
            member: None,
        };
        native
            .open(Frame::at_home(pin, Look::default()), Instant::now())
            .unwrap();
        assert!(!native.is_empty());
        NATIVE.with(|slot| *slot.borrow_mut() = Some(native));
    }
    if loading {
        reading.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    crate::desktop::on_exit(app.handle());
    if loading {
        assert_eq!(
            dropped.recv_timeout(Duration::from_secs(5)).unwrap(),
            2,
            "render worker and its owner must release the notifier before shell teardown"
        );
        drop(release);
        std::process::exit(0);
    }
    if mode == "pin" {
        std::process::exit(0);
    }
    crate::desktop::on_exit(app.handle());
    NATIVE.with(|slot| assert!(slot.borrow().is_none()));
    with(app.handle(), true, |_| panic!("late work must not run")).unwrap();
    with_existing(app.handle(), |_| panic!("late work must not run"));
    NATIVE.with(|slot| assert!(slot.borrow().is_none()));
    std::process::exit(0);
}
