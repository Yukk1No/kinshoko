use std::io;

use kinshoko_core::CommandError;
use windows::core::HRESULT;
use windows_registry::{CURRENT_USER, Key, LOCAL_MACHINE, Type};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

use super::apply_autostart_change;

const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

pub(super) enum Registration<'a> {
    Missing,
    Enabled,
    // The approval can survive removal of its Run entry.
    Disabled(Option<&'a Key>),
}

impl Registration<'_> {
    pub(super) fn enabled(&self) -> bool {
        matches!(self, Self::Enabled)
    }

    pub(super) fn update(
        self,
        name: &str,
        on: bool,
        explicit: bool,
        enable: impl FnOnce() -> Result<(), CommandError>,
        disable: impl FnOnce() -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        apply_autostart_change(
            self.enabled(),
            on,
            || match self {
                Self::Disabled(_) if !explicit => Ok(()),
                Self::Disabled(Some(root)) => {
                    // Change approval in the existing scope; the plugin's enable can
                    // pick a different hive depending on the process's elevation.
                    root.options()
                        .write()
                        .open(APPROVED)
                        .and_then(|key| key.set_bytes(name, Type::Bytes, &ENABLED))
                        .map_err(io::Error::from)
                        .map_err(CommandError::system)
                }
                _ => enable(),
            },
            disable,
        )
    }
}

pub(super) fn read(name: &str) -> io::Result<Registration<'static>> {
    read_scopes(name, [CURRENT_USER, LOCAL_MACHINE])
}

fn read_scopes<'a>(
    name: &str,
    scopes: impl IntoIterator<Item = &'a Key>,
) -> io::Result<Registration<'a>> {
    let mut has_veto = false;
    let mut disabled_root = None;
    for root in scopes {
        let registered = optional(root.open(RUN).and_then(|key| key.get_string(name)))?.is_some();
        let disabled = optional(root.open(APPROVED).and_then(|key| key.get_value(name)))?
            .is_some_and(|value| {
                value.ty() == Type::Bytes
                    && value.len() == ENABLED.len()
                    && matches!(value[..4], [3 | 7, 0, 0, 0])
            });
        if disabled {
            has_veto = true;
            if registered {
                disabled_root.get_or_insert(root);
            }
        } else if registered {
            return Ok(Registration::Enabled);
        }
    }
    Ok(if has_veto {
        Registration::Disabled(disabled_root)
    } else {
        Registration::Missing
    })
}

fn optional<T>(result: windows_registry::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND)
                || error.code() == HRESULT::from_win32(ERROR_PATH_NOT_FOUND) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "Kinshoko";
    const DISABLED: [u8; 12] = [3, 0, 0, 0, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 1];

    struct TestHive(String);

    impl TestHive {
        fn new() -> Self {
            Self(format!(
                r"Software\KinshokoStartupTest-{}",
                uuid::Uuid::new_v4()
            ))
        }

        fn key(&self) -> Key {
            CURRENT_USER.create(&self.0).unwrap()
        }
    }

    impl Drop for TestHive {
        fn drop(&mut self) {
            let _ = CURRENT_USER.remove_tree(&self.0);
        }
    }

    #[test]
    fn startup_does_not_enable_windows_disabled_registration() {
        let hive = TestHive::new();
        let root = hive.key();
        let run = root.create(RUN).unwrap();
        let approved = root.create(APPROVED).unwrap();
        let command = r#""C:\Test\Kinshoko.exe" --autostart"#;
        run.set_string(NAME, command).unwrap();
        approved.set_bytes(NAME, Type::Bytes, &DISABLED).unwrap();

        let registration = read_scopes(NAME, [&root]).unwrap();
        assert!(!registration.enabled());
        registration
            .update(
                NAME,
                true,
                false,
                || panic!("launch tried to enable a Windows-disabled entry"),
                || panic!("launch tried to remove a Windows-disabled entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &DISABLED);
        assert_eq!(run.get_string(NAME).unwrap(), command);

        read_scopes(NAME, [&root])
            .unwrap()
            .update(
                NAME,
                true,
                true,
                || panic!("explicit toggle should preserve the entry's scope"),
                || panic!("explicit toggle should not remove the entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &ENABLED);
        assert!(read_scopes(NAME, [&root]).unwrap().enabled());
    }

    #[test]
    fn missing_registration_still_bootstraps_unless_windows_left_a_veto() {
        let hive = TestHive::new();
        let root = hive.key();
        let enabled = std::cell::Cell::new(false);
        read_scopes(NAME, [&root])
            .unwrap()
            .update(
                NAME,
                true,
                false,
                || {
                    enabled.set(true);
                    Ok(())
                },
                || panic!("nothing to remove"),
            )
            .unwrap();
        assert!(enabled.get());

        let approved = root.create(APPROVED).unwrap();
        approved.set_bytes(NAME, Type::Bytes, &DISABLED).unwrap();
        let registration = read_scopes(NAME, [&root]).unwrap();
        assert!(!registration.enabled());
        registration
            .update(
                NAME,
                true,
                false,
                || panic!("passive sync should preserve the veto"),
                || panic!("nothing to remove"),
            )
            .unwrap();
    }
}
