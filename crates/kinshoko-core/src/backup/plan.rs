//! 自动备份计划：备份目标、范围与最近一次结果，存在应用数据目录的 `backup.json`
//! （`KINSHOKO_DATA_DIR` 覆盖时随之）。
//!
//! 每天第一次退出或空闲时自动备份一次：设了备份目标、今天（本地日期）还没成功过就到期。
//! 目标不在等原因失败时记下并提醒画师；隔一段时间后的下一次退出或空闲再试，不会一直重试。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    BackupError, BackupEstimate, BackupProgress, BackupReport, BackupScope, ScopeSelection, Stamp,
};

const FILE: &str = "backup.json";
const FORMAT: &str = "kinshoko.backup-plan";
const FORMAT_VERSION: u32 = 1;
/// 失败后至少隔这么久才再自动试。
const RETRY_AFTER_MS: i64 = 30 * 60 * 1000;

/// 最近一次失败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupFailure {
    pub at: Stamp,
    pub reason: String,
    /// 备份目标不在（移动盘没插等）。
    pub target_unavailable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PlanFile {
    format: String,
    format_version: u32,
    target: Option<PathBuf>,
    selection: ScopeSelection,
    last_success: Option<Stamp>,
    last_snapshot: Option<String>,
    last_failure: Option<BackupFailure>,
}

impl Default for PlanFile {
    fn default() -> Self {
        PlanFile {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            target: None,
            selection: ScopeSelection::All,
            last_success: None,
            last_snapshot: None,
            last_failure: None,
        }
    }
}

/// 给界面看的计划与状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupPlanView {
    pub target: Option<String>,
    pub selection: ScopeSelection,
    pub last_success: Option<Stamp>,
    pub last_snapshot: Option<String>,
    /// 最近一次失败；之后成功过就清掉。
    pub last_failure: Option<BackupFailure>,
    /// 自动备份到期（下次退出或空闲时进行）。
    pub due: bool,
}

/// 应用壳推给界面的备份状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupStatus {
    pub plan: BackupPlanView,
    /// 正在备份时的进度。
    pub running: Option<BackupProgress>,
    /// 本次运行里最近一次备份的结果。
    pub last_report: Option<BackupReport>,
}

/// 执行前给画师看的范围与容量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupPreview {
    pub scope: BackupScope,
    pub estimate: BackupEstimate,
    /// 备份目标现在在不在；不在时容量按全部需要复制估计。
    pub target_available: bool,
}

/// 本设备的自动备份计划。每次修改都立即写回磁盘。
pub struct BackupPlan {
    path: PathBuf,
    file: PlanFile,
}

impl BackupPlan {
    /// 读取 `dir/backup.json`；没有时为空计划（还没选备份目标）。
    pub fn open(dir: &Path) -> io::Result<BackupPlan> {
        let path = dir.join(FILE);
        let file = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => PlanFile::default(),
            Err(e) => return Err(e),
        };
        Ok(BackupPlan { path, file })
    }

    pub fn target(&self) -> Option<&Path> {
        self.file.target.as_deref()
    }

    pub fn selection(&self) -> &ScopeSelection {
        &self.file.selection
    }

    pub fn view(&self, now: Stamp) -> BackupPlanView {
        BackupPlanView {
            target: self
                .file
                .target
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            selection: self.file.selection.clone(),
            last_success: self.file.last_success,
            last_snapshot: self.file.last_snapshot.clone(),
            last_failure: self.file.last_failure.clone(),
            due: self.due(now),
        }
    }

    /// 选择（或清除）备份目标。换了目标后今天还要再备份一次。
    pub fn set_target(&mut self, target: Option<&Path>) -> io::Result<()> {
        self.update(|f| {
            if f.target.as_deref() != target {
                f.last_success = None;
                f.last_snapshot = None;
                f.last_failure = None;
            }
            f.target = target.map(Path::to_path_buf);
        })
    }

    pub fn set_selection(&mut self, selection: ScopeSelection) -> io::Result<()> {
        self.update(|f| f.selection = selection)
    }

    /// 自动备份到期：有备份目标，今天（本地日期）还没成功备份过，且最近没有刚失败过。
    pub fn due(&self, now: Stamp) -> bool {
        if self.file.target.is_none() {
            return false;
        }
        if self
            .file
            .last_success
            .is_some_and(|s| s.local_day() >= now.local_day())
        {
            return false;
        }
        self.file
            .last_failure
            .as_ref()
            .is_none_or(|f| now.unix_ms - f.at.unix_ms >= RETRY_AFTER_MS)
    }

    /// 记下一次完整备份。
    pub fn record_success(&mut self, at: Stamp, snapshot_id: &str) -> io::Result<()> {
        self.update(|f| {
            f.last_success = Some(at);
            f.last_snapshot = Some(snapshot_id.to_owned());
            f.last_failure = None;
        })
    }

    /// 记下一次失败（或不完整的备份）；界面据此提醒，下次再试。
    pub fn record_failure(&mut self, at: Stamp, error: &BackupError) -> io::Result<()> {
        self.record_problem(
            at,
            error.to_string(),
            matches!(error, BackupError::TargetUnavailable(_)),
        )
    }

    /// 记下备份没有完成的原因（例如原图内容不符）。
    pub fn record_problem(
        &mut self,
        at: Stamp,
        reason: String,
        target_unavailable: bool,
    ) -> io::Result<()> {
        self.update(|f| {
            f.last_failure = Some(BackupFailure {
                at,
                reason,
                target_unavailable,
            })
        })
    }

    fn update(&mut self, change: impl FnOnce(&mut PlanFile)) -> io::Result<()> {
        let mut next = self.file.clone();
        change(&mut next);
        next.format = FORMAT.into();
        next.format_version = FORMAT_VERSION;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&next).map_err(io::Error::other)?;
        {
            use std::io::Write;
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        self.file = next;
        Ok(())
    }
}
