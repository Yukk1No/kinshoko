//! 自动更新（#70）：Tauri updater 从 GitHub Releases 的 `latest.json` 检查新版本，下载安装包、
//! 用 `tauri.conf.json` 里的公钥校验签名，再以 NSIS 被动模式安装并重启。
//!
//! 私有阶段只用安装包手动更新。公开阶段必须明确声明原仓库已公开，并有原仓库入口与更新公钥。
//! 签名私钥只在 GitHub 仓库的 Actions secret 里，不进仓库（见 docs/validation/release-checklist.md）。

use std::sync::Mutex;

use kinshoko_core::{UpdatePolicy, UpdateProgress, UpdateStatus};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt as _};

const PROGRESS_EVENT: &str = "update-progress";

pub struct UpdaterState {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<Update>>,
}

impl UpdaterState {
    pub fn new(app: &AppHandle) -> Self {
        let status = update_policy(app).initial_status();
        UpdaterState {
            status: Mutex::new(status),
            pending: Mutex::new(None),
        }
    }

    fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set(&self, status: UpdateStatus) -> UpdateStatus {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        status
    }
}

/// 每个动作读取当前构建条件；阶段配置与插件的签名、下载配置共用一个入口。
fn update_policy(app: &AppHandle) -> UpdatePolicy {
    let updater = app.config().plugins.0.get("updater");
    let stage = updater
        .and_then(|u| u.get("releaseStage"))
        .map(|s| s.as_str().unwrap_or_default());
    let pubkey = updater
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str());
    let endpoints = updater
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|e| {
            e.iter()
                .map(|url| url.as_str().unwrap_or_default().to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    UpdatePolicy::for_build(stage, pubkey, &endpoints)
}
/// 上次检查的结果；还没检查过时为 `unchecked`。
#[tauri::command]
pub async fn update_status(state: State<'_, UpdaterState>) -> Result<UpdateStatus, String> {
    Ok(state.status())
}

/// 向 GitHub Releases 检查新版本。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateStatus, String> {
    let policy = update_policy(&app);
    if policy.require_automatic().is_err() {
        *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Ok(state.set(policy.initial_status()));
    }
    // 新检查不能留下上一次的可安装对象（例如本次已最新或检查失败）。
    *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // 交给安装程序前收好钉图状态：安装程序会结束本进程与打标子进程。
    let exiting = app.clone();
    let checked = match app
        .updater_builder()
        .on_before_exit(move || crate::desktop::on_exit(&exiting))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let status = match checked {
        Ok(Some(update)) => {
            let status = UpdateStatus::Available {
                version: update.version.clone(),
                notes: update.body.clone().filter(|b| !b.trim().is_empty()),
            };
            *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
            status
        }
        Ok(None) => UpdateStatus::UpToDate,
        Err(e) => {
            eprintln!("检查更新失败：{e}");
            UpdateStatus::Failed {
                message: "检查更新失败，请检查网络后重试。".to_owned(),
            }
        }
    };
    Ok(state.set(status))
}

/// 下载并安装已检查到的新版本。成功时安装程序接管，本进程退出、装好后重新启动。
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let policy = update_policy(&app);
    if let Err(message) = policy.require_automatic() {
        *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
        state.set(policy.initial_status());
        return Err(message);
    }
    let Some(update) = state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    else {
        return Err("没有可以安装的更新，请先检查更新。".to_owned());
    };
    let mut downloaded = 0u64;
    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await;
    // 走到这里说明没有交给安装程序（Windows 上安装成功时进程已退出）。
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("安装更新失败：{e}");
            let message = match e {
                tauri_plugin_updater::Error::Minisign(_)
                | tauri_plugin_updater::Error::SignatureUtf8(_) => {
                    "更新包签名不对，已放弃安装。".to_owned()
                }
                _ => "下载或安装更新失败，请稍后重试。".to_owned(),
            };
            state.set(UpdateStatus::Failed {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

pub fn manage(app: &AppHandle) {
    app.manage(UpdaterState::new(app));
}
