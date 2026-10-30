//! 读参考组包：核对清单与原文件，导入到资料库。

use super::*;

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
        Some(1 | FORMAT_VERSION | CAPTURE_FORMAT_VERSION) => {}
        Some(v) if v > CAPTURE_FORMAT_VERSION => return Err(GroupError::UnsupportedVersion(v)),
        _ => return Err(damaged(ErrorKind::WrongFormatVersion, "格式版本不对")),
    }
    // 第 2 版起标签带身份定义与来源本地标签对应。
    let defined_tags = header.format_version >= Some(FORMAT_VERSION);
    let file: ManifestFile = serde_json::from_slice(&bytes).map_err(GroupError::damaged)?;
    let manifest = file.manifest;
    let mut definitions = BTreeMap::new();
    for image in &manifest.images {
        for tag in &image.snapshot.tags {
            if defined_tags && tag.definition.is_none() {
                return Err(damaged(
                    ErrorKind::PackageNoDefinitions,
                    "新版参考组包缺少标签身份定义",
                ));
            }
            if defined_tags
                && tag
                    .local_tag_id
                    .as_ref()
                    .is_none_or(|id| id.trim().is_empty())
            {
                return Err(damaged(
                    ErrorKind::PackageNoLocalMappings,
                    "新版参考组包缺少来源本地标签对应",
                ));
            }
            if let Some(definition) = &tag.definition {
                definition.validate().map_err(GroupError::damaged)?;
                if definition.namespace != tag.namespace {
                    return Err(damaged(
                        ErrorKind::PackageDefinitionNamespace,
                        "标签定义命名空间不同",
                    ));
                }
                if let Some(previous) = definitions.insert(&definition.id, definition)
                    && previous != definition
                {
                    return Err(damaged(
                        ErrorKind::PackageConflictingDefinitions,
                        "同一标签身份包含不同定义",
                    ));
                }
            }
        }
    }
    manifest.group.validate().map_err(|e| match e {
        GroupError::Invalid(why) => GroupError::PackageDamaged(why),
        other => other,
    })?;
    // 每个截图文件名都要核对，成员没用到的也一样：导入时按它写进新参考组的目录。
    let mut capture_files = std::collections::BTreeSet::new();
    for capture in &manifest.captures {
        if !super::super::member::valid_capture_file(&capture.file) {
            return Err(damaged(
                ErrorKind::CaptureFileInvalid {
                    file: capture.file.clone(),
                },
                format!("截图文件名 {} 不合法", capture.file),
            ));
        }
        if !capture_files.insert(capture.file.as_str()) {
            return Err(damaged(
                ErrorKind::PackageCaptureDuplicate {
                    file: capture.file.clone(),
                },
                format!("截图 {} 重复", capture.file),
            ));
        }
    }
    for m in &manifest.group.members {
        if manifest.image(m).is_none() && manifest.capture(m).is_none() {
            return Err(damaged(
                ErrorKind::PackageMemberNoImage {
                    member: m.id.clone(),
                },
                format!("成员 {} 没有对应的原图", m.id),
            ));
        }
    }
    Ok(manifest)
}

/// 包内一份组内截图的全部字节；与清单记录的大小或 SHA-256 不符时为损坏。
fn read_capture(
    zip: &mut ZipArchive<fs::File>,
    capture: &PackageCapture,
) -> Result<Vec<u8>, GroupError> {
    let mut entry = zip.by_name(&capture.entry()).map_err(|_| {
        damaged(
            ErrorKind::PackageCaptureMissing {
                file: capture.entry(),
            },
            format!("缺少截图 {}", capture.entry()),
        )
    })?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(GroupError::damaged)?;
    if bytes.len() as u64 != capture.size || sha256_hex(&bytes) != capture.sha256 {
        return Err(damaged(
            ErrorKind::PackageCaptureMismatch {
                file: capture.entry(),
            },
            format!("截图 {} 与清单记录不符", capture.entry()),
        ));
    }
    Ok(bytes)
}

/// 包内一份原文件的全部字节；与清单记录的大小或 SHA-256 不符时为损坏。
fn read_original(
    zip: &mut ZipArchive<fs::File>,
    image: &PackageImage,
) -> Result<Vec<u8>, GroupError> {
    let mut entry = zip
        .by_name(&image.file)
        .map_err(|_| image_missing(&image.file))?;
    let mut bytes = Vec::with_capacity(usize::try_from(image.size).unwrap_or(0));
    entry.read_to_end(&mut bytes).map_err(GroupError::damaged)?;
    if bytes.len() as u64 != image.size || sha256_hex(&bytes) != image.snapshot.sha256 {
        return Err(image_mismatch(&image.file));
    }
    Ok(bytes)
}

/// 导入参考组包到 `library`，另存为新的参考组（由 [`super::ReferenceGroups::import_package`] 写入）。
/// 一并返回参考组自带的截图（文件名与字节），随新参考组写入，不进资料库。
pub(in super::super) fn import(
    path: &Path,
    library: &Library,
    catalog: Option<&crate::tag_catalog::CatalogInspection>,
) -> Result<(ReferenceGroup, CaptureFiles), GroupError> {
    let mut zip = open(path)?;
    let manifest = read_manifest(&mut zip)?;
    if let Some(catalog) = catalog {
        let definitions = manifest
            .images
            .iter()
            .flat_map(|image| image.snapshot.tags.iter())
            .filter_map(|tag| tag.definition.clone())
            .collect::<Vec<_>>();
        catalog
            .validate_content_dependencies(&definitions)
            .map_err(GroupError::library)?;
    }
    // 先核对全部原图，包有损坏时资料库里什么都不写。
    for image in &manifest.images {
        let mut entry = zip
            .by_name(&image.file)
            .map_err(|_| image_missing(&image.file))?;
        let mut hasher = Sha256::new();
        let size = io::copy(&mut entry, &mut hasher).map_err(GroupError::damaged)?;
        let sha = hex(&hasher.finalize());
        if size != image.size || sha != image.snapshot.sha256 {
            return Err(image_mismatch(&image.file));
        }
    }
    let captures = manifest
        .captures
        .iter()
        .map(|c| Ok((c.file.clone(), read_capture(&mut zip, c)?)))
        .collect::<Result<Vec<_>, GroupError>>()?;

    // 来源库中的“资料库＋参考图” → 本库的参考图。
    let mut imported: HashMap<(String, String), String> = HashMap::new();
    for image in &manifest.images {
        let origin = PackageOrigin {
            package_id: manifest.package_id.clone(),
            source_library_id: image.library_id.clone(),
            source_image_id: image.image_id.clone(),
            group_id: manifest.group.id.clone(),
            group_name: manifest.group.name.clone(),
            exported_at: manifest.exported_at,
            location: std::path::absolute(path)
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .into_owned(),
        };
        let bytes = read_original(&mut zip, image)?;
        let id = library
            .import_from_package(&origin, &bytes, &image.snapshot)
            .map_err(|e| {
                let (done, total) = (imported.len(), manifest.images.len());
                GroupError::library(CommandError::caused_by(
                    e,
                    |cause| ErrorKind::PackageImportStopped {
                        done,
                        total,
                        number: done + 1,
                        cause,
                    },
                    |e| {
                        format!(
                            "包导入已完成 {done} / {total} 项，第 {} 项失败：{e}。已写入内容保留；参考组尚未保存。",
                            done + 1
                        )
                    },
                ))
            })?;
        imported.insert((image.library_id.clone(), image.image_id.clone()), id);
    }

    let library_id = library.info().id.clone();
    let now = crate::library::now_ms();
    let members = manifest
        .group
        .members
        .iter()
        .map(|m| match m.source.library_image() {
            Some((source_library, source_image)) => GroupMember {
                source: MemberSource::Library {
                    library_id: library_id.clone(),
                    image_id: imported[&(source_library.to_owned(), source_image.to_owned())]
                        .clone(),
                },
                ..m.clone()
            },
            None => m.clone(),
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
    Ok((group, captures))
}
