//! 本地备份与恢复（Backup，#69）：范围计算、容量估计、快照、历史保留与恢复编排。
//!
//! 只通过 Library 与 ReferenceGroups 提供的依赖清单与快照入口接触它们的存储，不认识资料库的
//! 磁盘布局。

mod scope;

pub use scope::{BackupScope, ScopeItem, ScopeSelection, ScopeStep, Uncovered, compute_scope};
