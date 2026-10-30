//! Portable application configuration; no Library content or device registrations are replaced.
//! A durable undo journal makes the catalog/settings pair recover as one configuration.
use crate::CommandError;
use crate::command_error::ErrorKind;
use crate::{
    AppSettings, SettingsSnapshot,
    tag_catalog::{CatalogSettingsSnapshot, TagCatalog},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use ts_rs::TS;
const FORMAT: &str = "kinshoko-application-settings";
const JOURNAL: &str = "application-settings-restore.json";
static RESTORE_GATE: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    format: String,
    version: u32,
    settings: SettingsSnapshot,
    catalog: CatalogSettingsSnapshot,
}
impl Package {
    fn validate(&self) -> Result<(), CommandError> {
        if self.format != FORMAT || self.version != 1 {
            return Err(CommandError::new(
                ErrorKind::SettingsBackupIncompatible,
                "不是兼容的程序设置备份，请更新 Kinshoko 或选择其他备份",
            ));
        }
        self.settings.validate()?;
        self.catalog.validate().map_err(CommandError::from)
    }
}
fn read(path: &Path) -> Result<Package, CommandError> {
    let bytes = fs::read(path).map_err(unreadable)?;
    let package: Package = serde_json::from_slice(&bytes).map_err(invalid)?;
    package.validate()?;
    Ok(package)
}
fn write(path: &Path, package: &Package) -> Result<(), CommandError> {
    let parent = path.parent().ok_or_else(|| {
        CommandError::new(ErrorKind::SettingsBackupNoLocation, "请选择备份文件位置")
    })?;
    fs::create_dir_all(parent).map_err(CommandError::from)?;
    let temp = parent.join(format!(".settings-{}.tmp", uuid::Uuid::now_v7().simple()));
    let result = (|| {
        let mut file = File::create(&temp).map_err(CommandError::from)?;
        file.write_all(&serde_json::to_vec_pretty(package).map_err(CommandError::from)?)
            .map_err(CommandError::from)?;
        file.sync_all().map_err(CommandError::from)?;
        drop(file);
        fs::rename(&temp, path).map_err(CommandError::from)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn recover_in_place(
    settings: &mut AppSettings,
    catalog: &mut TagCatalog,
) -> Result<bool, CommandError> {
    let path = catalog.directory().join(JOURNAL);
    if !path.exists() {
        return Ok(false);
    }
    let previous = read(&path).map_err(|e| {
        CommandError::caused_by(
            e,
            |cause| ErrorKind::SettingsRestorePending { cause },
            |e| format!("上次设置恢复尚未完成：{e}"),
        )
    })?;
    catalog
        .replace_settings_snapshot(&previous.catalog)
        .map_err(CommandError::from)?;
    settings
        .replace(&previous.settings)
        .map_err(CommandError::from)?;
    fs::remove_file(&path).map_err(CommandError::from)?;
    Ok(true)
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplicationSettingsPreview {
    pub fingerprint: String,
    pub safe_mode: bool,
    pub force_srgb: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplicationSettingsRestored {
    pub settings: crate::ShellSettingsView,
    pub safe_mode: bool,
    /// 设置已恢复，但没有完全生效的部分。
    #[ts(as = "Vec<crate::command_error::ErrorKind>")]
    pub problems: Vec<crate::CommandError>,
}
pub struct ApplicationSettingsBackup;
impl ApplicationSettingsBackup {
    /// Call before opening the live shell/catalog. Interrupted restores roll back completely.
    pub fn recover(data_dir: &Path, config_dir: &Path) -> Result<bool, CommandError> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if !data_dir.join(JOURNAL).exists() {
            return Ok(false);
        }
        let mut catalog = TagCatalog::open(data_dir).map_err(CommandError::from)?;
        let mut settings = AppSettings::open(config_dir).map_err(CommandError::from)?;
        recover_in_place(&mut settings, &mut catalog)
    }
    pub fn inspect(path: &Path) -> Result<ApplicationSettingsPreview, CommandError> {
        let bytes = fs::read(path).map_err(unreadable)?;
        let package: Package = serde_json::from_slice(&bytes).map_err(invalid)?;
        package.validate()?;
        Ok(ApplicationSettingsPreview {
            fingerprint: format!("{:x}", Sha256::digest(bytes)),
            safe_mode: package.settings.safe_mode(),
            force_srgb: package.settings.force_srgb(),
        })
    }
    pub fn export(
        settings: &AppSettings,
        catalog: &TagCatalog,
        path: &Path,
    ) -> Result<(), CommandError> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if catalog.directory().join(JOURNAL).exists() {
            return Err(CommandError::new(
                ErrorKind::SettingsRestoreUnfinished,
                "上次设置恢复尚未完成，请重启后再备份",
            ));
        }
        if path
            .extension()
            .is_none_or(|ext| ext != "kinshoko-settings")
        {
            return Err(CommandError::new(
                ErrorKind::SettingsBackupExtension,
                "程序设置备份文件必须使用 .kinshoko-settings 扩展名",
            ));
        }
        let package = Package {
            format: FORMAT.into(),
            version: 1,
            settings: settings.snapshot().complete_portable(),
            catalog: catalog
                .settings_snapshot()
                .map_err(CommandError::from)?
                .portable(),
        };
        package.validate()?;
        write(path, &package)
    }
    pub fn restore(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
    ) -> Result<(), CommandError> {
        Self::restore_expected(settings, catalog, path, None)
    }
    pub fn restore_checked(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
        fingerprint: &str,
    ) -> Result<(), CommandError> {
        Self::restore_expected(settings, catalog, path, Some(fingerprint))
    }
    fn restore_expected(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
        fingerprint: Option<&str>,
    ) -> Result<(), CommandError> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        recover_in_place(settings, catalog)?;
        let bytes = fs::read(path).map_err(CommandError::from)?;
        if fingerprint.is_some_and(|expected| expected != format!("{:x}", Sha256::digest(&bytes))) {
            return Err(CommandError::new(
                ErrorKind::SettingsBackupChanged,
                "备份文件已变化，请重新读取并确认替换范围",
            ));
        }
        let mut package: Package = serde_json::from_slice(&bytes).map_err(invalid)?;
        package.validate()?;
        package.settings = package.settings.complete_portable();
        let prepared = catalog
            .prepare_settings_replacement(&package.catalog)
            .map_err(CommandError::from)?;
        prepared.validate().map_err(CommandError::from)?;
        let previous = Package {
            format: FORMAT.into(),
            version: 1,
            settings: settings.snapshot(),
            catalog: catalog.settings_snapshot().map_err(CommandError::from)?,
        };
        let journal = catalog.directory().join(JOURNAL);
        write(&journal, &previous)?;
        let mut settings_published = false;
        let result = (|| {
            crate::library::fault::storage("settings_restore_after_journal")
                .map_err(CommandError::from)?;
            catalog
                .replace_settings_snapshot(&prepared)
                .map_err(CommandError::from)?;
            crate::library::fault::storage("settings_restore_after_catalog")
                .map_err(CommandError::from)?;
            settings
                .replace(&package.settings)
                .map_err(CommandError::from)?;
            settings_published = true;
            crate::library::fault::storage("settings_restore_after_settings")
                .map_err(CommandError::from)?;
            // Deleting the durable undo journal is the publication point for the whole pair.
            fs::remove_file(&journal).map_err(CommandError::from)?;
            Ok(())
        })();
        if let Err(error) = result {
            catalog
                .replace_settings_snapshot(&previous.catalog)
                .map_err(|rollback| rollback_failed(&error, rollback, false))?;
            if settings_published {
                settings
                    .replace(&previous.settings)
                    .map_err(|rollback| rollback_failed(&error, rollback, false))?;
            }
            fs::remove_file(&journal)
                .map_err(|rollback| rollback_failed(&error, rollback, true))?;
            return Err(error);
        }
        Ok(())
    }
}

fn unreadable(e: std::io::Error) -> CommandError {
    CommandError::new(
        ErrorKind::SettingsBackupUnreadable {
            detail: e.to_string(),
        },
        format!("无法读取程序设置备份：{e}"),
    )
}

fn invalid(e: serde_json::Error) -> CommandError {
    CommandError::new(
        ErrorKind::SettingsBackupInvalid {
            detail: e.to_string(),
        },
        format!("程序设置备份无效：{e}"),
    )
}

/// 恢复失败后回退也没做完（`journal_kept`：恢复记录还留着）。
fn rollback_failed(
    error: &CommandError,
    rollback: impl Into<CommandError>,
    journal_kept: bool,
) -> CommandError {
    let rollback = rollback.into();
    let text = if journal_kept {
        format!("{error}；恢复记录保留，请重启：{rollback}")
    } else {
        format!("{error}；回退未完成，请重启：{rollback}")
    };
    CommandError::new(
        ErrorKind::SettingsRollbackIncomplete {
            cause: Box::new(error.kind.clone()),
            rollback: Box::new(rollback.kind),
            journal_kept,
        },
        text,
    )
}
