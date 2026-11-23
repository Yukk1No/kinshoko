use std::io;

use auto_launch::{AutoLaunch, WindowsEnableMode};
use kinshoko_core::CommandError;
use windows::core::HRESULT;
use windows_registry::{CURRENT_USER, Key, LOCAL_MACHINE, Type};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

use super::{AUTOSTART_ARG, apply_autostart_change};

const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const APPROVAL_LEN: usize = 12;

pub(super) enum Registration {
    Missing,
    Enabled,
    // The approval can survive removal of its Run entry.
    Disabled(WindowsEnableMode),
}

impl Registration {
    pub(super) fn enabled(&self) -> bool {
        matches!(self, Self::Enabled)
    }

    pub(super) fn update(
        self,
        on: bool,
        explicit: bool,
        enable: impl FnOnce(WindowsEnableMode) -> Result<(), CommandError>,
        disable: impl FnOnce() -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        let mode = match self {
            Self::Disabled(_) if !explicit => return Ok(()),
            Self::Disabled(mode) => mode,
            _ => WindowsEnableMode::Dynamic,
        };
        apply_autostart_change(self.enabled(), on, || enable(mode), disable)
    }
}

pub(super) fn read(name: &str) -> io::Result<Registration> {
    read_scopes(
        name,
        [
            (CURRENT_USER, WindowsEnableMode::CurrentUser),
            (LOCAL_MACHINE, WindowsEnableMode::Dynamic),
        ],
    )
}

pub(super) fn enable(name: &str, mode: WindowsEnableMode) -> Result<(), CommandError> {
    let exe = std::env::current_exe().map_err(CommandError::system)?;
    let path = format!("\"{}\"", exe.display());
    AutoLaunch::new(name, &path, mode, &[AUTOSTART_ARG])
        .enable()
        .map_err(CommandError::system)
}

fn read_scopes<'a>(
    name: &str,
    scopes: impl IntoIterator<Item = (&'a Key, WindowsEnableMode)>,
) -> io::Result<Registration> {
    let mut veto_mode = None;
    for (root, mode) in scopes {
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
        if disabled {
            veto_mode.get_or_insert(mode);
        }
    }
    Ok(veto_mode.map_or(Registration::Missing, Registration::Disabled))
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
    use WindowsEnableMode::{CurrentUser, Dynamic};

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

        let registration = read_scopes(NAME, [(&root, Dynamic)]).unwrap();
        assert!(!registration.enabled());
        registration
            .update(
                true,
                false,
                |_| panic!("launch tried to enable a Windows-disabled entry"),
                || panic!("launch tried to remove a Windows-disabled entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &DISABLED);
        assert_eq!(run.get_string(NAME).unwrap(), command);

        let moved_command = r#""D:\New Location\Kinshoko.exe" --autostart"#;
        read_scopes(NAME, [(&root, Dynamic)])
            .unwrap()
            .update(
                true,
                true,
                |mode| {
                    assert_eq!(mode, Dynamic);
                    run.set_string(NAME, moved_command).unwrap();
                    approved.set_bytes(NAME, Type::Bytes, &ENABLED).unwrap();
                    Ok(())
                },
                || panic!("explicit toggle should not remove the entry"),
            )
            .unwrap();
        assert_eq!(&*approved.get_value(NAME).unwrap(), &ENABLED);
        assert_eq!(run.get_string(NAME).unwrap(), moved_command);
        assert!(read_scopes(NAME, [(&root, Dynamic)]).unwrap().enabled());
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

        let scopes = [(&user, CurrentUser), (&machine, Dynamic)];
        read_scopes(NAME, scopes)
            .unwrap()
            .update(
                true,
                true,
                |mode| {
                    assert_eq!(mode, Dynamic);
                    user.create(RUN).unwrap().set_string(NAME, command).unwrap();
                    Ok(())
                },
                || panic!("an explicit enable should not remove the entry"),
            )
            .unwrap();

        assert!(read_scopes(NAME, scopes).unwrap().enabled());
        assert_eq!(&*machine_approved.get_value(NAME).unwrap(), &DISABLED);
        assert_eq!(user.open(RUN).unwrap().get_string(NAME).unwrap(), command);
    }

    #[test]
    fn explicit_enable_keeps_a_per_user_veto_in_the_user_hive() {
        let user_hive = TestHive::new();
        let machine_hive = TestHive::new();
        let user = user_hive.key();
        let machine = machine_hive.key();
        let command = r#""C:\Test\Kinshoko.exe" --autostart"#;
        user.create(RUN).unwrap().set_string(NAME, command).unwrap();
        let user_approved = user.create(APPROVED).unwrap();
        user_approved
            .set_bytes(NAME, Type::Bytes, &DISABLED)
            .unwrap();

        let scopes = [(&user, CurrentUser), (&machine, Dynamic)];
        read_scopes(NAME, scopes)
            .unwrap()
            .update(
                true,
                true,
                |mode| {
                    assert_eq!(mode, CurrentUser);
                    user_approved
                        .set_bytes(NAME, Type::Bytes, &ENABLED)
                        .unwrap();
                    Ok(())
                },
                || panic!("an explicit enable should not remove the entry"),
            )
            .unwrap();

        assert!(optional(machine.open(RUN)).unwrap().is_none());
        assert_eq!(&*user_approved.get_value(NAME).unwrap(), &ENABLED);
        assert!(read_scopes(NAME, scopes).unwrap().enabled());
    }

    #[test]
    fn missing_registration_still_bootstraps_unless_windows_left_a_veto() {
        let hive = TestHive::new();
        let root = hive.key();
        let enabled = std::cell::Cell::new(false);
        read_scopes(NAME, [(&root, Dynamic)])
            .unwrap()
            .update(
                true,
                false,
                |mode| {
                    assert_eq!(mode, Dynamic);
                    enabled.set(true);
                    Ok(())
                },
                || panic!("nothing to remove"),
            )
            .unwrap();
        assert!(enabled.get());

        let approved = root.create(APPROVED).unwrap();
        approved.set_bytes(NAME, Type::Bytes, &DISABLED).unwrap();
        let registration = read_scopes(NAME, [(&root, Dynamic)]).unwrap();
        assert!(!registration.enabled());
        registration
            .update(
                true,
                false,
                |_| panic!("passive sync should preserve the veto"),
                || panic!("nothing to remove"),
            )
            .unwrap();
    }
}
