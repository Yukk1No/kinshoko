//! Portable application configuration; no Library content or device registrations are replaced.
//! A durable undo journal makes the catalog/settings pair recover as one configuration.
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
    fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT || self.version != 1 {
            return Err("不是兼容的程序设置备份，请更新 Kinshoko 或选择其他备份".into());
        }
        self.settings.validate()?;
        self.catalog.validate().map_err(|e| e.to_string())
    }
}
fn read(path: &Path) -> Result<Package, String> {
    let bytes = fs::read(path).map_err(|e| format!("无法读取程序设置备份：{e}"))?;
    let package: Package =
        serde_json::from_slice(&bytes).map_err(|e| format!("程序设置备份无效：{e}"))?;
    package.validate()?;
    Ok(package)
}
fn write(path: &Path, package: &Package) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "请选择备份文件位置".to_owned())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".settings-{}.tmp", uuid::Uuid::now_v7().simple()));
    let result = (|| {
        let mut file = File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(package).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn recover_in_place(settings: &mut AppSettings, catalog: &mut TagCatalog) -> Result<bool, String> {
    let path = catalog.directory().join(JOURNAL);
    if !path.exists() {
        return Ok(false);
    }
    let previous = read(&path).map_err(|e| format!("上次设置恢复尚未完成：{e}"))?;
    catalog
        .replace_settings_snapshot(&previous.catalog)
        .map_err(|e| e.to_string())?;
    settings
        .replace(&previous.settings)
        .map_err(|e| e.to_string())?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
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
    pub problems: Vec<String>,
}
pub struct ApplicationSettingsBackup;
impl ApplicationSettingsBackup {
    /// Call before opening the live shell/catalog. Interrupted restores roll back completely.
    pub fn recover(data_dir: &Path, config_dir: &Path) -> Result<bool, String> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if !data_dir.join(JOURNAL).exists() {
            return Ok(false);
        }
        let mut catalog = TagCatalog::open(data_dir).map_err(|e| e.to_string())?;
        let mut settings = AppSettings::open(config_dir).map_err(|e| e.to_string())?;
        recover_in_place(&mut settings, &mut catalog)
    }
    pub fn inspect(path: &Path) -> Result<ApplicationSettingsPreview, String> {
        let bytes = fs::read(path).map_err(|e| format!("无法读取程序设置备份：{e}"))?;
        let package: Package =
            serde_json::from_slice(&bytes).map_err(|e| format!("程序设置备份无效：{e}"))?;
        package.validate()?;
        Ok(ApplicationSettingsPreview {
            fingerprint: format!("{:x}", Sha256::digest(bytes)),
            safe_mode: package.settings.safe_mode(),
            force_srgb: package.settings.force_srgb(),
        })
    }
    pub fn export(settings: &AppSettings, catalog: &TagCatalog, path: &Path) -> Result<(), String> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if catalog.directory().join(JOURNAL).exists() {
            return Err("上次设置恢复尚未完成，请重启后再备份".into());
        }
        if path
            .extension()
            .is_none_or(|ext| ext != "kinshoko-settings")
        {
            return Err("程序设置备份文件必须使用 .kinshoko-settings 扩展名".into());
        }
        let package = Package {
            format: FORMAT.into(),
            version: 1,
            settings: settings.snapshot().complete_portable(),
            catalog: catalog
                .settings_snapshot()
                .map_err(|e| e.to_string())?
                .portable(),
        };
        package.validate()?;
        write(path, &package)
    }
    pub fn restore(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
    ) -> Result<(), String> {
        Self::restore_expected(settings, catalog, path, None)
    }
    pub fn restore_checked(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
        fingerprint: &str,
    ) -> Result<(), String> {
        Self::restore_expected(settings, catalog, path, Some(fingerprint))
    }
    fn restore_expected(
        settings: &mut AppSettings,
        catalog: &mut TagCatalog,
        path: &Path,
        fingerprint: Option<&str>,
    ) -> Result<(), String> {
        let _gate = RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner());
        recover_in_place(settings, catalog)?;
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if fingerprint.is_some_and(|expected| expected != format!("{:x}", Sha256::digest(&bytes))) {
            return Err("备份文件已变化，请重新读取并确认替换范围".into());
        }
        let mut package: Package =
            serde_json::from_slice(&bytes).map_err(|e| format!("程序设置备份无效：{e}"))?;
        package.validate()?;
        package.settings = package.settings.complete_portable();
        let prepared = catalog
            .prepare_settings_replacement(&package.catalog)
            .map_err(|e| e.to_string())?;
        prepared.validate().map_err(|e| e.to_string())?;
        let previous = Package {
            format: FORMAT.into(),
            version: 1,
            settings: settings.snapshot(),
            catalog: catalog.settings_snapshot().map_err(|e| e.to_string())?,
        };
        let journal = catalog.directory().join(JOURNAL);
        write(&journal, &previous)?;
        let mut settings_published = false;
        let result = (|| {
            crate::library::fault::storage("settings_restore_after_journal")
                .map_err(|e| e.to_string())?;
            catalog
                .replace_settings_snapshot(&prepared)
                .map_err(|e| e.to_string())?;
            crate::library::fault::storage("settings_restore_after_catalog")
                .map_err(|e| e.to_string())?;
            settings
                .replace(&package.settings)
                .map_err(|e| e.to_string())?;
            settings_published = true;
            crate::library::fault::storage("settings_restore_after_settings")
                .map_err(|e| e.to_string())?;
            // Deleting the durable undo journal is the publication point for the whole pair.
            fs::remove_file(&journal).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = result {
            catalog
                .replace_settings_snapshot(&previous.catalog)
                .map_err(|rollback| format!("{error}；回退未完成，请重启：{rollback}"))?;
            if settings_published {
                settings
                    .replace(&previous.settings)
                    .map_err(|rollback| format!("{error}；回退未完成，请重启：{rollback}"))?;
            }
            fs::remove_file(&journal)
                .map_err(|rollback| format!("{error}；恢复记录保留，请重启：{rollback}"))?;
            return Err(error);
        }
        Ok(())
    }
}
