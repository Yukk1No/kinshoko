//! 打标要覆盖的资料库（ADR-0008 修订，#414）：调度器空闲时自己逐个询问它们还有没有未打标的图，
//! 写入方不必通知它。真实来源是应用壳里的本设备登记（`DeviceLibraries` 的可写句柄），测试用固定的几个库。

use std::sync::Arc;

use crate::{CommandError, Library};

/// 打标的资料库来源。
pub trait TaggingLibraries: Send + Sync {
    /// 已登记的资料库身份，按登记顺序。
    fn library_ids(&self) -> Vec<String>;
    /// 给这个库打标用的可写句柄；同一个库始终是同一个句柄。暂时打不开时返回原因，调度器跳过它。
    fn writer(&self, library_id: &str) -> Result<Arc<Library>, CommandError>;
}

/// 固定的几个资料库，按给出的顺序。
impl TaggingLibraries for Vec<Arc<Library>> {
    fn library_ids(&self) -> Vec<String> {
        self.iter()
            .map(|library| library.info().id.clone())
            .collect()
    }

    fn writer(&self, library_id: &str) -> Result<Arc<Library>, CommandError> {
        self.iter()
            .find(|library| library.info().id == library_id)
            .cloned()
            .ok_or_else(|| crate::DeviceLibraryError::UnknownLibrary.into())
    }
}
