//! 参考组包（#68，ADR-0002）：把参考组连同所用原图与整理信息快照带走，脱离原资料库使用或带到别的电脑。
//!
//! 包是一个不压缩的 zip（原图逐字节放进去，从不重编码）：
//!
//! ```text
//! manifest.json               format "kinshoko.reference-group-package"、formatVersion、包 id、导出时间、
//!                             参考组（成员、局部与摆放原样）、所用参考图的快照与原文件位置
//! originals/<sha256>.<ext>    所用原图，同一原图只带一次
//! captures/<文件名>           参考组自带的截图（#270），导入时还原到新参考组里，不进资料库
//! ```
//!
//! 只带参考组用到的图，不带来源库的其他素材，也不带完整操作历史。快照（标签、备注、来源链接、分级）
//! 只是导出时的样子，不反向更新来源库。
//!
//! 导入时先逐个核对原图的 SHA-256，包有损坏就什么都不写；然后原图经资料库的导入流程进库（字节相同
//! 的合并为同一条记录），快照按 `package:<包 id>:<来源库 id>:<来源图 id>` 来源分层写入；最后另存为新的参考组：新身份，
//! 成员、局部与摆放逐字一致，改指向导入它的资料库，并记下 `importedFromPackage`。
//! 中途失败时已进库的图留着，重新导入同一个包会合并到它们上面，不会重复。

use super::MemberUnavailable;
use crate::CommandError;
use crate::command_error::ErrorKind;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::captures::CaptureFiles;
use super::packages::PackageCapture;
use super::{
    GroupError, GroupMember, MemberSource, MemberState, ReferenceGroup, ReferenceSource, new_id,
    resolve,
};
use crate::Library;
use crate::library::{ImageSnapshot, PackageOrigin};

mod import;
pub(super) use import::import;
pub use import::read_package;

const FORMAT: &str = "kinshoko.reference-group-package";
const FORMAT_VERSION: u32 = 2;
/// 带组内截图的包按这一版写，旧版本读到时提示升级；不带的仍按 [`FORMAT_VERSION`]。
const CAPTURE_FORMAT_VERSION: u32 = 3;
const MANIFEST: &str = "manifest.json";
pub(super) const CAPTURES: &str = "captures";
/// 参考组包文件的扩展名。
pub const PACKAGE_EXTENSION: &str = "kinshoko-group";

/// 参考组来自哪个参考组包（`imported_from_package`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackageProvenance {
    pub package_id: String,
    /// 导出这个包的参考组。
    pub group_id: String,
    /// 导出时间（Unix 毫秒）。
    #[ts(type = "number")]
    pub exported_at: i64,
}

/// 包里的一张参考图：来源库中的身份、包内原文件与导出时的整理信息快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackageImage {
    pub library_id: String,
    pub image_id: String,
    /// 包内原文件的位置（`originals/<sha256>.<ext>`）。
    pub file: String,
    #[ts(type = "number")]
    pub size: u64,
    pub snapshot: ImageSnapshot,
}

/// 参考组包的清单。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackageManifest {
    pub package_id: String,
    #[ts(type = "number")]
    pub exported_at: i64,
    /// 导出时的参考组，成员按来源库引用。
    pub group: ReferenceGroup,
    /// 成员用到的参考图，每个“资料库＋参考图”一项。
    pub images: Vec<PackageImage>,
    /// 参考组自带的截图（#270），每个文件一项。
    #[serde(default)]
    pub captures: Vec<PackageCapture>,
}

impl PackageManifest {
    fn image(&self, member: &GroupMember) -> Option<&PackageImage> {
        let (library_id, image_id) = member.source.library_image()?;
        self.images
            .iter()
            .find(|i| i.library_id == library_id && i.image_id == image_id)
    }

    fn capture(&self, member: &GroupMember) -> Option<&PackageCapture> {
        let MemberSource::Capture { capture_file } = &member.source else {
            return None;
        };
        self.captures.iter().find(|c| &c.file == capture_file)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    format: String,
    format_version: u32,
    #[serde(flatten)]
    manifest: PackageManifest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: Option<String>,
    format_version: Option<u32>,
}

fn image_missing(file: &str) -> GroupError {
    damaged(
        ErrorKind::PackageImageMissing {
            file: file.to_owned(),
        },
        format!("缺少原图 {file}"),
    )
}

fn image_mismatch(file: &str) -> GroupError {
    damaged(
        ErrorKind::PackageImageMismatch {
            file: file.to_owned(),
        },
        format!("原图 {file} 与清单记录不符"),
    )
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn damaged(kind: ErrorKind, text: impl Into<String>) -> GroupError {
    GroupError::damaged(CommandError::new(kind, text))
}

/// 导出参考组 `group` 到 `out`。成员有任何一个此刻取不到原图（资料库不可用、图已删除、原文件缺失）
/// 就不导出，列出这些成员；原文件与资料库记录的 SHA-256 不符也不导出。参考组自带的截图从
/// `captures` 目录逐字节带上。先写临时文件再改名替换。
pub(super) fn export(
    group: &ReferenceGroup,
    source: &dyn ReferenceSource,
    out: &Path,
    catalog: Option<&crate::tag_catalog::CatalogInspection>,
    captures: &Path,
) -> Result<PackageManifest, GroupError> {
    let mut unavailable: Vec<MemberUnavailable> = resolve(group, source)
        .into_iter()
        .filter_map(|m| match m.state {
            MemberState::Unavailable { reason, .. } => Some(MemberUnavailable {
                member: Some(m.member_id),
                reason,
            }),
            MemberState::Available { .. } => None,
        })
        .collect();
    // 组内截图：文件名 → 字节，同一文件只带一次。
    let mut capture_bytes: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for m in &group.members {
        if let MemberSource::Capture { capture_file } = &m.source
            && !capture_bytes.contains_key(capture_file)
        {
            match fs::read(captures.join(capture_file)) {
                Ok(bytes) => {
                    capture_bytes.insert(capture_file.clone(), bytes);
                }
                Err(_) => unavailable.push(MemberUnavailable {
                    member: Some(m.id.clone()),
                    reason: super::UnavailableReason::CaptureMissing,
                }),
            }
        }
    }
    if !unavailable.is_empty() {
        return Err(GroupError::MembersUnavailable(unavailable));
    }

    let mut images: Vec<PackageImage> = Vec::new();
    // sha256 → 来源库里的原文件；同一原图只带一次。
    let mut files: BTreeMap<String, (String, std::path::PathBuf)> = BTreeMap::new();
    for (library_id, image_id) in group
        .members
        .iter()
        .filter_map(|m| m.source.library_image())
    {
        if images
            .iter()
            .any(|i| i.library_id == library_id && i.image_id == image_id)
        {
            continue;
        }
        let lens = source.lens(library_id).map_err(|reason| {
            GroupError::MembersUnavailable(vec![MemberUnavailable {
                member: None,
                reason,
            }])
        })?;
        let library_error = GroupError::library;
        let mut snapshot = lens.snapshot(image_id).map_err(library_error)?;
        if let Some(catalog) = catalog {
            catalog
                .apply_content_definitions(library_id, &mut snapshot)
                .map_err(GroupError::library)?;
        }
        let original = lens.original_path(image_id).map_err(library_error)?;
        let ext = original
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let file = format!("originals/{}.{ext}", snapshot.sha256);
        let size = fs::metadata(&original)?.len();
        files
            .entry(snapshot.sha256.clone())
            .or_insert_with(|| (file.clone(), original));
        images.push(PackageImage {
            library_id: library_id.to_owned(),
            image_id: image_id.to_owned(),
            file: files[&snapshot.sha256].0.clone(),
            size,
            snapshot,
        });
    }
    let manifest = PackageManifest {
        package_id: new_id(),
        exported_at: crate::library::now_ms(),
        group: group.clone(),
        images,
        captures: capture_bytes
            .iter()
            .map(|(file, bytes)| PackageCapture {
                file: file.clone(),
                size: bytes.len() as u64,
                sha256: sha256_hex(bytes),
            })
            .collect(),
    };
    let format_version = if manifest.captures.is_empty() {
        FORMAT_VERSION
    } else {
        CAPTURE_FORMAT_VERSION
    };

    let dir = out.parent().filter(|p| !p.as_os_str().is_empty());
    let tmp = match dir {
        Some(d) => d.join(format!(".kinshoko-package.tmp-{}", new_id())),
        None => format!(".kinshoko-package.tmp-{}", new_id()).into(),
    };
    let written = (|| -> Result<(), GroupError> {
        let mut zip = ZipWriter::new(fs::File::create(&tmp)?);
        for (sha, (file, original)) in &files {
            let bytes = fs::read(original)?;
            if sha256_hex(&bytes) != *sha {
                return Err(damaged(
                    ErrorKind::PackageOriginalMismatch {
                        path: original.display().to_string(),
                    },
                    format!("原文件 {} 与资料库记录不符", original.display()),
                ));
            }
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(bytes.len() as u64 >= u32::MAX as u64);
            zip.start_file(file.as_str(), options)
                .map_err(GroupError::damaged)?;
            zip.write_all(&bytes)?;
        }
        for capture in &manifest.captures {
            zip.start_file(
                capture.entry(),
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .map_err(GroupError::damaged)?;
            zip.write_all(&capture_bytes[&capture.file])?;
        }
        let json = serde_json::to_vec_pretty(&ManifestFile {
            format: FORMAT.to_owned(),
            format_version,
            manifest: manifest.clone(),
        })
        .map_err(io::Error::other)?;
        zip.start_file(
            MANIFEST,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .map_err(GroupError::damaged)?;
        zip.write_all(&json)?;
        let file = zip.finish().map_err(GroupError::damaged)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, out)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map(|()| manifest)
}
