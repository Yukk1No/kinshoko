use std::process::Command;

use kinshoko_core::desktop::{PinContent, Placement, SavedPin};
use tauri::test::{mock_context, noop_assets};

use super::*;
use crate::desktop::pins::native::{Frame, Look};

const CHILD_ENV: &str = "KINSHOKO_NATIVE_EXIT_CHILD";
const TEST: &str =
    "desktop::pins::native::host::tests::native_pins_are_disposed_before_process_exit";

#[test]
fn native_pins_are_disposed_before_process_exit() {
    if let Ok(mode) = std::env::var(CHILD_ENV) {
        child(&mode);
    }
    for mode in ["pin", "empty"] {
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

fn child(mode: &str) -> ! {
    let app = tauri::Builder::default()
        .any_thread()
        .build(mock_context(noop_assets()))
        .unwrap();
    if mode == "pin" {
        NATIVE.with(|slot| assert!(slot.borrow().is_none()));
        let shell = WinShell::new(|| {}).unwrap();
        let render = RenderThread::start(Arc::new(|_, _| Err("unused".into())), Arc::new(|_| {}));
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
    crate::desktop::on_exit(app.handle());
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
