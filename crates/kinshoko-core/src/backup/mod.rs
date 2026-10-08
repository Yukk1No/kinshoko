//! 本地备份与恢复（Backup，#69）：范围计算、容量估计、快照、历史保留与恢复编排。
//!
//! - 目标是画师选的本地目录（[`BackupTarget`]）；原文件按哈希增量复制，SQLite 用 Online Backup，
//!   备份期间持有原文件租约；保留最近 7 份每日快照与 4 份每周快照。
//! - 恢复生成独立的资料库与参考组副本，记录 `restore_provenance` 与 `restored_from`，恢复后
//!   自动运行往返检查（[`RoundTripCheck`]）。
//! - 每天第一次退出或空闲时自动备份一次（[`BackupPlan`]）；目标不在时记下、提醒，下次再试。
//!
//! 只通过 Library 与 ReferenceGroups 提供的依赖清单与快照入口接触它们的存储，不认识资料库的
//! 磁盘布局。

mod plan;
mod restore;
mod retention;
pub use restore::recover_restores;
mod scope;
mod stamp;
mod target;

pub use plan::{BackupFailure, BackupPlan, BackupPlanView, BackupPreview, BackupStatus};
pub use scope::{BackupScope, ScopeItem, ScopeSelection, ScopeStep, Uncovered, compute_scope};
pub use stamp::Stamp;
pub use target::{
    BackupError, BackupEstimate, BackupProgress, BackupReport, BackupSources, BackupTarget,
    CheckPart, RestoreReport, RestoredGroup, RestoredLibrary, RoundTripCheck, SkippedLibrary,
    SnapshotSummary,
};
