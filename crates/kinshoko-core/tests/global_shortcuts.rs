//! 全局快捷键：启动时按设置注册，被别的程序占用时标出“未注册”，可在设置中更换并立即生效。
//!
//! 系统的全局热键表用内存假实现代替：真实注册要占用本机按键，CI 上也没有桌面会话。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use kinshoko_core::{AppSettings, GlobalShortcuts, HotkeyRegistrar, ShortcutAction};

/// 假的系统热键表。`taken` 是别的程序（例如绘画软件或 Snipaste）已占用的键。
#[derive(Clone, Default)]
struct FakeHotkeys {
    inner: Arc<Mutex<FakeTable>>,
}

#[derive(Default)]
struct FakeTable {
    taken: BTreeSet<String>,
    ours: BTreeMap<String, ShortcutAction>,
}

impl FakeHotkeys {
    fn with_taken(keys: &[&str]) -> Self {
        let fake = FakeHotkeys::default();
        fake.inner.lock().unwrap().taken = keys.iter().map(|k| k.to_string()).collect();
        fake
    }

    /// 现在按下 `key` 会触发我们的哪个动作。
    fn press(&self, key: &str) -> Option<ShortcutAction> {
        self.inner.lock().unwrap().ours.get(key).copied()
    }
}

impl HotkeyRegistrar for FakeHotkeys {
    fn register(&mut self, action: ShortcutAction, accelerator: &str) -> Result<(), String> {
        let mut table = self.inner.lock().unwrap();
        if table.taken.contains(accelerator) || table.ours.contains_key(accelerator) {
            return Err("已被其他程序占用".to_owned());
        }
        table.ours.insert(accelerator.to_owned(), action);
        Ok(())
    }

    fn unregister(&mut self, accelerator: &str) {
        self.inner.lock().unwrap().ours.remove(accelerator);
    }
}

#[test]
fn on_start_every_bound_key_is_registered_and_a_key_held_elsewhere_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::with_taken(&["F1"]);

    let shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    assert_eq!(hotkeys.press("F1"), None);
    assert_eq!(hotkeys.press("F3"), Some(ShortcutAction::PinClipboard));
    assert_eq!(hotkeys.press("F4"), Some(ShortcutAction::HideAllPins));
    let capture = &shortcuts.bindings(&settings)[0];
    assert_eq!(capture.action, ShortcutAction::Capture);
    assert_eq!(capture.accelerator.as_deref(), Some("F1"));
    assert_eq!(capture.problem.as_deref(), Some("已被其他程序占用"));
    assert_eq!(shortcuts.bindings(&settings)[1].problem, None);
}

#[test]
fn rebinding_takes_effect_immediately_and_is_remembered_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    shortcuts
        .rebind(&mut settings, ShortcutAction::Capture, Some("Ctrl+Alt+A"))
        .unwrap();

    assert_eq!(hotkeys.press("F1"), None);
    assert_eq!(hotkeys.press("Ctrl+Alt+A"), Some(ShortcutAction::Capture));
    let reopened = AppSettings::open(dir.path()).unwrap();
    assert_eq!(
        reopened.shortcut(ShortcutAction::Capture),
        Some("Ctrl+Alt+A")
    );
}

#[test]
fn a_key_held_by_another_program_is_refused_and_the_old_key_keeps_working() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::with_taken(&["Ctrl+Z"]);
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    let err = shortcuts
        .rebind(&mut settings, ShortcutAction::Capture, Some("Ctrl+Z"))
        .unwrap_err();

    assert!(err.to_string().contains("已被其他程序占用"), "{err}");
    assert_eq!(hotkeys.press("F1"), Some(ShortcutAction::Capture));
    assert_eq!(settings.shortcut(ShortcutAction::Capture), Some("F1"));
    assert_eq!(
        AppSettings::open(dir.path())
            .unwrap()
            .shortcut(ShortcutAction::Capture),
        Some("F1")
    );
}

#[test]
fn a_key_already_used_by_another_action_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    let err = shortcuts
        .rebind(&mut settings, ShortcutAction::Capture, Some("f3"))
        .unwrap_err();

    assert!(err.to_string().contains("钉剪贴板"), "{err}");
    assert_eq!(hotkeys.press("F1"), Some(ShortcutAction::Capture));
    assert_eq!(hotkeys.press("F3"), Some(ShortcutAction::PinClipboard));
}

#[test]
fn after_freeing_the_key_in_the_other_program_the_artist_can_retry_the_same_key() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::with_taken(&["F1"]);
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);
    hotkeys.inner.lock().unwrap().taken.clear();

    shortcuts
        .rebind(&mut settings, ShortcutAction::Capture, Some("F1"))
        .unwrap();

    assert_eq!(hotkeys.press("F1"), Some(ShortcutAction::Capture));
    assert_eq!(shortcuts.bindings(&settings)[0].problem, None);
}

#[test]
fn rebinding_to_the_key_already_in_use_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    shortcuts
        .rebind(&mut settings, ShortcutAction::HideAllPins, Some("F4"))
        .unwrap();

    assert_eq!(hotkeys.press("F4"), Some(ShortcutAction::HideAllPins));
}

#[test]
fn clearing_a_shortcut_frees_the_key_and_stays_cleared_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    shortcuts
        .rebind(&mut settings, ShortcutAction::PinClipboard, None)
        .unwrap();

    assert_eq!(hotkeys.press("F3"), None);
    let reopened = AppSettings::open(dir.path()).unwrap();
    assert_eq!(reopened.shortcut(ShortcutAction::PinClipboard), None);
    let restarted = GlobalShortcuts::start(FakeHotkeys::default(), &reopened);
    assert_eq!(restarted.bindings(&reopened)[1].accelerator, None);
}

#[test]
fn shortcuts_are_saved_in_one_spelling_whatever_the_settings_screen_sends() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    shortcuts
        .rebind(
            &mut settings,
            ShortcutAction::Capture,
            Some("shift + control+KeyQ"),
        )
        .unwrap();
    shortcuts
        .rebind(
            &mut settings,
            ShortcutAction::PinClipboard,
            Some("alt+Digit2"),
        )
        .unwrap();

    assert_eq!(
        settings.shortcut(ShortcutAction::Capture),
        Some("Ctrl+Shift+Q")
    );
    assert_eq!(hotkeys.press("Ctrl+Shift+Q"), Some(ShortcutAction::Capture));
    assert_eq!(
        settings.shortcut(ShortcutAction::PinClipboard),
        Some("Alt+2")
    );
}

#[test]
fn keys_that_would_get_in_the_way_of_typing_or_have_no_main_key_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let hotkeys = FakeHotkeys::default();
    let mut shortcuts = GlobalShortcuts::start(hotkeys.clone(), &settings);

    for bad in ["", "Ctrl+Shift", "Q", "Shift+Q", "7", "Ctrl+A+B"] {
        let result = shortcuts.rebind(&mut settings, ShortcutAction::Capture, Some(bad));
        assert!(result.is_err(), "应拒绝 {bad:?}");
    }
    assert_eq!(hotkeys.press("F1"), Some(ShortcutAction::Capture));
    assert_eq!(settings.shortcut(ShortcutAction::Capture), Some("F1"));
}
