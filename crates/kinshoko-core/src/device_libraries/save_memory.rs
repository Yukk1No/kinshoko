//! 保存入口各自记住的位置（ADR-0016）。

use std::path::Path;

use super::{DeviceLibraries, DeviceLibraryError};
use crate::SaveMemory;
use crate::library::SaveDestination;

impl DeviceLibraries {
    /// 保存入口的记忆。记住的新建位置此刻不在（移动盘没插）时这次不给，记录保留，插回来后恢复。
    pub fn save_memory(&self) -> SaveMemory {
        let mut memory = self.device.save_memory().clone();
        memory.new_library_parent = memory.new_library_parent.filter(|parent| parent.is_dir());
        memory
    }

    pub fn remember_import_destination(
        &mut self,
        destination: &SaveDestination,
    ) -> Result<(), DeviceLibraryError> {
        Ok(self.device.remember_import_destination(destination)?)
    }

    pub fn remember_new_library_parent(&mut self, parent: &Path) -> Result<(), DeviceLibraryError> {
        Ok(self.device.remember_new_library_parent(parent)?)
    }
}
