//! 参考组包（#68）的入口：导出、导入后另存为新的参考组，连同参考组自带的截图（#270）。

use std::fs;
use std::path::Path;

use super::captures::write_atomically;
use super::{
    GroupError, PackageManifest, ReferenceGroup, ReferenceGroups, ReferenceSource, package,
};
use crate::Library;

/// Imported package content whose new group is not saved yet. Application adapters can
/// publish tag definitions after all package IO, then finish without exposing group file details.
/// Dropping this result keeps imported content and leaves no new group, so re-import is safe.
pub struct PackageImport<'a> {
    groups: &'a ReferenceGroups,
    group: ReferenceGroup,
    /// 包里的组内截图：文件名与字节，随新参考组一起写入。
    captures: package::CaptureFiles,
}

impl PackageImport<'_> {
    pub fn finish(self) -> Result<ReferenceGroup, GroupError> {
        let dir = self.groups.captures_dir(&self.group.id)?;
        let written = (|| -> Result<(), GroupError> {
            for (file, bytes) in &self.captures {
                fs::create_dir_all(&dir)?;
                write_atomically(&dir.join(file), bytes)?;
            }
            self.groups.write(&self.group)
        })();
        if written.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        written.map(|()| self.group)
    }
}

impl ReferenceGroups {
    /// 把参考组 `id` 导出成参考组包 `out`：带上所用原图（同一原图只带一次、不重编码）与标签、备注、
    /// 来源、分级的快照，以及它自带的截图，不带来源库的其他素材。成员引用的资料库可以是未激活的库；
    /// 有成员此刻取不到原图时不导出（[`GroupError::MembersUnavailable`]）。返回写进包里的清单。
    pub fn export_package(
        &self,
        id: &str,
        source: &dyn ReferenceSource,
        out: &Path,
    ) -> Result<PackageManifest, GroupError> {
        package::export(&self.get(id)?, source, out, None, &self.captures_dir(id)?)
    }

    /// Export using the current application definition, without publishing to read-only providers.
    pub fn export_package_with_catalog(
        &self,
        id: &str,
        source: &dyn ReferenceSource,
        out: &Path,
        catalog: &crate::tag_catalog::TagCatalog,
    ) -> Result<PackageManifest, GroupError> {
        let snapshot = catalog
            .inspect()
            .map_err(|e| GroupError::Library(e.to_string()))?;
        package::export(
            &self.get(id)?,
            source,
            out,
            Some(&snapshot),
            &self.captures_dir(id)?,
        )
    }

    /// 导入参考组包：原图进 `library`（字节相同的合并），快照按参考组包来源分层写入，再另存为新的
    /// 参考组（新身份，成员、局部与摆放与包里一致，记下 `importedFromPackage`）。包有损坏时什么都不写。
    pub fn import_package(
        &self,
        package: &Path,
        library: &Library,
    ) -> Result<ReferenceGroup, GroupError> {
        self.prepare_package_import(package, library, None)?
            .finish()
    }

    /// Check the same package manifest against a fixed catalog inspection and import its
    /// content without holding the application catalog lock during file IO or decoding.
    pub fn prepare_package_import(
        &self,
        package: &Path,
        library: &Library,
        catalog: Option<&crate::tag_catalog::CatalogInspection>,
    ) -> Result<PackageImport<'_>, GroupError> {
        let (group, captures) = package::import(package, library, catalog)?;
        Ok(PackageImport {
            groups: self,
            group,
            captures,
        })
    }

    /// Import content against the current application catalog while preserving its settings.
    pub fn import_package_with_catalog(
        &self,
        package: &Path,
        library: &Library,
        catalog: &mut crate::tag_catalog::TagCatalog,
    ) -> Result<ReferenceGroup, GroupError> {
        let snapshot = catalog
            .inspect()
            .map_err(|error| GroupError::Library(error.to_string()))?;
        let imported = self.prepare_package_import(package, library, Some(&snapshot))?;
        catalog.publish_library_definitions(library).map_err(|error| GroupError::Library(format!(
            "内容已写入，但资料库标签定义尚未更新：{error}。请重试保存标签定义或重新导入参考组包。"
        )))?;
        imported.finish()
    }
}
