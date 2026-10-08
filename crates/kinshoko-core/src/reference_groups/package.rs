//! 参考组包（#68，ADR-0002）：把参考组连同所用原图与整理信息快照带走，脱离原资料库使用或带到别的电脑。
//!
//! 包是一个不压缩的 zip（原图逐字节放进去，从不重编码）：
//!
//! ```text
//! manifest.json               format "kinshoko.reference-group-package"、formatVersion、包 id、导出时间、
//!                             参考组（成员、局部与摆放原样）、所用参考图的快照与原文件位置
//! originals/<sha256>.<ext>    所用原图，同一原图只带一次
//! ```
//!
//! 只带参考组用到的图，不带来源库的其他素材，也不带完整操作历史。快照（标签、备注、来源链接、分级）
//! 只是导出时的样子，不反向更新来源库。
//!
//! 导入时先逐个核对原图的 SHA-256，包有损坏就什么都不写；然后原图经资料库的导入流程进库（字节相同
//! 的合并为同一条记录），快照按 `package:<包 id>` 来源分层写入；最后另存为新的参考组：新身份，
//! 成员、局部与摆放逐字一致，改指向导入它的资料库，并记下 `importedFromPackage`。
//! 中途失败时已进库的图留着，重新导入同一个包会合并到它们上面，不会重复。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::{
    GroupError, GroupMember, MemberState, ReferenceGroup, ReferenceSource, new_id, resolve,
};
use crate::Library;
use crate::library::{ImageSnapshot, PackageOrigin};

const FORMAT: &str = "kinshoko.reference-group-package";
const FORMAT_VERSION: u32 = 1;
const MANIFEST: &str = "manifest.json";
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
}

impl PackageManifest {
    fn image(&self, member: &GroupMember) -> Option<&PackageImage> {
        self.images
            .iter()
            .find(|i| i.library_id == member.library_id && i.image_id == member.image_id)
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

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn damaged(why: impl std::fmt::Display) -> GroupError {
    GroupError::PackageDamaged(why.to_string())
}

/// 导出参考组 `group` 到 `out`。成员有任何一个此刻取不到原图（资料库不可用、图已删除、原文件缺失）
/// 就不导出，列出这些成员；原文件与资料库记录的 SHA-256 不符也不导出。先写临时文件再改名替换。
pub(super) fn export(
    group: &ReferenceGroup,
    source: &dyn ReferenceSource,
    out: &Path,
) -> Result<PackageManifest, GroupError> {
    let unavailable: Vec<String> = resolve(group, source)
        .into_iter()
        .filter_map(|m| match m.state {
            MemberState::Unavailable { message, .. } => {
                Some(format!("成员 {}：{message}", m.member_id))
            }
            MemberState::Available { .. } => None,
        })
        .collect();
    if !unavailable.is_empty() {
        return Err(GroupError::MembersUnavailable(unavailable));
    }

    let mut images: Vec<PackageImage> = Vec::new();
    // sha256 → 来源库里的原文件；同一原图只带一次。
    let mut files: BTreeMap<String, (String, std::path::PathBuf)> = BTreeMap::new();
    for m in &group.members {
        if images
            .iter()
            .any(|i| i.library_id == m.library_id && i.image_id == m.image_id)
        {
            continue;
        }
        let lens = source
            .lens(&m.library_id)
            .map_err(|reason| GroupError::MembersUnavailable(vec![reason.to_string()]))?;
        let library_error = |e: crate::library::Error| GroupError::Library(e.to_string());
        let snapshot = lens.snapshot(&m.image_id).map_err(library_error)?;
        let original = lens.original_path(&m.image_id).map_err(library_error)?;
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
            library_id: m.library_id.clone(),
            image_id: m.image_id.clone(),
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
                return Err(damaged(format!(
                    "原文件 {} 与资料库记录不符",
                    original.display()
                )));
            }
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(bytes.len() as u64 >= u32::MAX as u64);
            zip.start_file(file.as_str(), options).map_err(damaged)?;
            zip.write_all(&bytes)?;
        }
        let json = serde_json::to_vec_pretty(&ManifestFile {
            format: FORMAT.to_owned(),
            format_version: FORMAT_VERSION,
            manifest: manifest.clone(),
        })
        .map_err(io::Error::other)?;
        zip.start_file(
            MANIFEST,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .map_err(damaged)?;
        zip.write_all(&json)?;
        let file = zip.finish().map_err(damaged)?;
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

/// 读出参考组包的清单（不核对原文件）。
pub fn read_package(path: &Path) -> Result<PackageManifest, GroupError> {
    let mut zip = open(path)?;
    read_manifest(&mut zip)
}

fn open(path: &Path) -> Result<ZipArchive<fs::File>, GroupError> {
    let file = fs::File::open(path)?;
    ZipArchive::new(file).map_err(|_| GroupError::NotAPackage)
}

fn read_manifest(zip: &mut ZipArchive<fs::File>) -> Result<PackageManifest, GroupError> {
    let mut bytes = Vec::new();
    zip.by_name(MANIFEST)
        .map_err(|_| GroupError::NotAPackage)?
        .read_to_end(&mut bytes)?;
    let header: Header = serde_json::from_slice(&bytes).map_err(|_| GroupError::NotAPackage)?;
    if header.format.as_deref() != Some(FORMAT) {
        return Err(GroupError::NotAPackage);
    }
    match header.format_version {
        Some(FORMAT_VERSION) => {}
        Some(v) if v > FORMAT_VERSION => return Err(GroupError::UnsupportedVersion(v)),
        _ => return Err(damaged("格式版本不对")),
    }
    let file: ManifestFile = serde_json::from_slice(&bytes).map_err(damaged)?;
    let manifest = file.manifest;
    manifest.group.validate().map_err(|e| match e {
        GroupError::Invalid(why) => damaged(why),
        other => other,
    })?;
    for m in &manifest.group.members {
        if manifest.image(m).is_none() {
            return Err(damaged(format!("成员 {} 没有对应的原图", m.id)));
        }
    }
    Ok(manifest)
}

/// 包内一份原文件的全部字节；与清单记录的大小或 SHA-256 不符时为损坏。
fn read_original(
    zip: &mut ZipArchive<fs::File>,
    image: &PackageImage,
) -> Result<Vec<u8>, GroupError> {
    let mut entry = zip
        .by_name(&image.file)
        .map_err(|_| damaged(format!("缺少原图 {}", image.file)))?;
    let mut bytes = Vec::with_capacity(usize::try_from(image.size).unwrap_or(0));
    entry.read_to_end(&mut bytes).map_err(damaged)?;
    if bytes.len() as u64 != image.size || sha256_hex(&bytes) != image.snapshot.sha256 {
        return Err(damaged(format!("原图 {} 与清单记录不符", image.file)));
    }
    Ok(bytes)
}

/// 导入参考组包到 `library`，另存为新的参考组（由 [`super::ReferenceGroups::import_package`] 写入）。
pub(super) fn import(path: &Path, library: &Library) -> Result<ReferenceGroup, GroupError> {
    let mut zip = open(path)?;
    let manifest = read_manifest(&mut zip)?;
    // 先核对全部原图，包有损坏时资料库里什么都不写。
    for image in &manifest.images {
        let mut entry = zip
            .by_name(&image.file)
            .map_err(|_| damaged(format!("缺少原图 {}", image.file)))?;
        let mut hasher = Sha256::new();
        let size = io::copy(&mut entry, &mut hasher).map_err(damaged)?;
        let sha = hex(&hasher.finalize());
        if size != image.size || sha != image.snapshot.sha256 {
            return Err(damaged(format!("原图 {} 与清单记录不符", image.file)));
        }
    }

    let origin = PackageOrigin {
        package_id: manifest.package_id.clone(),
        group_id: manifest.group.id.clone(),
        group_name: manifest.group.name.clone(),
        exported_at: manifest.exported_at,
        location: std::path::absolute(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
    };
    // 来源库中的“资料库＋参考图” → 本库的参考图。
    let mut imported: HashMap<(String, String), String> = HashMap::new();
    for image in &manifest.images {
        let bytes = read_original(&mut zip, image)?;
        let id = library
            .import_from_package(&origin, &bytes, &image.snapshot)
            .map_err(|e| GroupError::Library(e.to_string()))?;
        imported.insert((image.library_id.clone(), image.image_id.clone()), id);
    }

    let library_id = library.info().id.clone();
    let now = crate::library::now_ms();
    let members = manifest
        .group
        .members
        .iter()
        .map(|m| GroupMember {
            library_id: library_id.clone(),
            image_id: imported[&(m.library_id.clone(), m.image_id.clone())].clone(),
            ..m.clone()
        })
        .collect();
    let group = ReferenceGroup {
        id: new_id(),
        name: manifest.group.name.clone(),
        created_at: now,
        updated_at: now,
        members,
        imported_from_package: Some(PackageProvenance {
            package_id: manifest.package_id,
            group_id: manifest.group.id,
            exported_at: manifest.exported_at,
        }),
        restored_from: None,
    };
    group.validate()?;
    Ok(group)
}
