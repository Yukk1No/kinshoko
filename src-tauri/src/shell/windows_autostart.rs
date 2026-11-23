use std::io;

use kinshoko_core::CommandError;
use windows::core::HRESULT;
use windows_registry::{CURRENT_USER, Key, LOCAL_MACHINE, Type};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

use super::apply_autostart_change;

const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const APPROVAL_LEN: usize = 12;

pub(super) enum Registration {
    Missing,
    Enabled,
    // The approval can survive removal of its Run entry.
    Disabled,
}

impl Registration {
    pub(super) fn enabled(&self) -> bool {
        matches!(self, Self::Enabled)
    }

    pub(super) fn update(
        self,
        on: bool,
        explicit: bool,
        enable: impl FnOnce() -> Result<(), CommandError>,
        disable: impl FnOnce() -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        if !explicit && matches!(self, Self::Disabled) {
            return Ok(());
        }
        apply_autostart_change(self.enabled(), on, enable, disable)
    }
}

pub(super) fn read(name: &str) -> io::Result<Registration> {
    read_scopes(name, [CURRENT_USER, LOCAL_MACHINE])
}

fn read_scopes<'a>(
    name: &str,
    scopes: impl IntoIterator<Item = &'a Key>,
) -> io::Result<Registration> {
    let mut has_veto = false;
    for root in scopes {
        let registered = optional(root.open(RUN).and_then(|key| key.get_string(name)))?.is_some();
        let disabled = optional(root.open(APPROVED).and_then(|key| key.get_value(name)))?
            .is_some_and(|value| {
                value.ty() == Type::Bytes
                    && value.len() == APPROVAL_LEN
                    && matches!(value[..4], [3 | 7, 0, 0, 0])
            });
        if registered && !disabled {
            return Ok(Registration::Enabled);
        }
        has_veto |= disabled;
    }
    Ok(if has_veto {
        Registration::Disabled
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
    const ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
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
                true,
                false,
                || panic!("launch tried to enable a Windows-disabled entry"),
                || panic!("launch tried to remove a Windows-disabled entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &DISABLED);
        assert_eq!(run.get_string(NAME).unwrap(), command);

        let moved_command = r#""D:\New Location\Kinshoko.exe" --autostart"#;
        read_scopes(NAME, [&root])
            .unwrap()
            .update(
                true,
                true,
                || {
                    run.set_string(NAME, moved_command).unwrap();
                    approved.set_bytes(NAME, Type::Bytes, &ENABLED).unwrap();
                    Ok(())
                },
                || panic!("explicit toggle should not remove the entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &ENABLED);
        assert_eq!(run.get_string(NAME).unwrap(), moved_command);
        assert!(read_scopes(NAME, [&root]).unwrap().enabled());
    }

    #[test]
    fn explicit_enable_accepts_a_per_user_registration_without_clearing_machine_veto() {
        let user_hive = TestHive::new();
        let machine_hive = TestHive::new();
        let user = user_hive.key();
        let machine = machine_hive.key();
        let command = r#""C:\Test\Kinshoko.exe" --autostart"#;
        machine
            .create(RUN)
            .unwrap()
            .set_string(NAME, command)
            .unwrap();
        let machine_approved = machine.create(APPROVED).unwrap();
        machine_approved
            .set_bytes(NAME, Type::Bytes, &DISABLED)
            .unwrap();

        read_scopes(NAME, [&user, &machine])
            .unwrap()
            .update(
                true,
                true,
                || {
                    user.create(RUN).unwrap().set_string(NAME, command).unwrap();
                    Ok(())
                },
                || panic!("an explicit enable should not remove the entry"),
            )
            .unwrap();

        assert!(read_scopes(NAME, [&user, &machine]).unwrap().enabled());
        assert_eq!(&*machine_approved.get_value(NAME).unwrap(), &DISABLED);
        assert_eq!(user.open(RUN).unwrap().get_string(NAME).unwrap(), command);
    }

    #[test]
    fn missing_registration_still_bootstraps_unless_windows_left_a_veto() {
        let hive = TestHive::new();
        let root = hive.key();
        let enabled = std::cell::Cell::new(false);
        read_scopes(NAME, [&root])
            .unwrap()
            .update(
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
                true,
                false,
                || panic!("passive sync should preserve the veto"),
                || panic!("nothing to remove"),
            )
            .unwrap();
    }
}
