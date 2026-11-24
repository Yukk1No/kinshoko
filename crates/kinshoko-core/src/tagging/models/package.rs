//! 从文件导入模型包（没有网络时）。

use std::fs;
use std::io::Read;
use std::path::Path;

use super::*;

impl ModelStore {
    /// 从文件导入模型包（没有网络时）：zip 里有一个模型文件（`.onnx`，名字不限、可在子文件夹里）
    /// 和词表 `selected_tags.csv`。按大小与 SHA-256 认出是 `models` 中的哪一个，校验通过才装进
    /// 模型目录（随后在本机改写为分块注意力）；校验不过时什么也不留下。返回装好的模型。
    pub fn import_package(
        &self,
        package: &Path,
        models: &[ModelSpec],
    ) -> Result<ModelSpec, CommandError> {
        let file = fs::File::open(package).map_err(|e| {
            err(
                ErrorKind::ModelPackageUnopenable {
                    detail: e.to_string(),
                },
                format!("无法打开模型包：{e}"),
            )
        })?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| {
            err(
                ErrorKind::ModelPackageNotZip {
                    detail: e.to_string(),
                },
                format!("无法读取模型包（不是 zip）：{e}"),
            )
        })?;
        let unreadable = |e: &dyn std::fmt::Display| {
            err(
                ErrorKind::ModelPackageUnreadable {
                    detail: e.to_string(),
                },
                format!("无法读取模型包：{e}"),
            )
        };
        let (mut onnx, mut tags) = (None, None);
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| unreadable(&e))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("");
            if name.to_ascii_lowercase().ends_with(".onnx") {
                if onnx.is_some() {
                    return Err(err(
                        ErrorKind::ModelPackageManyModels,
                        "模型包里有不止一个模型文件（.onnx）",
                    ));
                }
                onnx = Some((i, name.to_owned(), entry.size()));
            } else if name == TAGS_FILE {
                tags = Some(i);
            }
        }
        let (onnx_index, onnx_name, size) = onnx.ok_or_else(|| {
            err(
                ErrorKind::ModelPackageNoModel,
                "模型包里没有模型文件（.onnx）",
            )
        })?;
        let tags_index = tags.ok_or_else(|| {
            err(
                ErrorKind::ModelPackageNoTags {
                    file: TAGS_FILE.into(),
                },
                format!("模型包里没有词表 {TAGS_FILE}"),
            )
        })?;
        let mut tags_csv = Vec::new();
        zip.by_index(tags_index)
            .map_err(|e| unreadable(&e))?
            .read_to_end(&mut tags_csv)
            .map_err(|e| unreadable(&e))?;
        check_tags_csv(&tags_csv)?;
        let candidates: Vec<&ModelSpec> = models.iter().filter(|s| s.size == size).collect();
        if candidates.is_empty() {
            return Err(err(
                ErrorKind::ModelPackageUnsupported {
                    file: onnx_name.clone(),
                },
                format!("模型包里的 {onnx_name} 不是 Kinshoko 支持的模型"),
            ));
        }

        // 先解压到模型目录里的临时文件，边写边算哈希；认出是哪个模型后再改名就位。
        fs::create_dir_all(&self.dir).map_err(dir_failed)?;
        let tmp = self
            .dir
            .join(format!(".import-{}.part", uuid::Uuid::new_v4()));
        let extracted = zip
            .by_index(onnx_index)
            .map_err(|e| unreadable(&e))
            .and_then(|mut entry| {
                let mut out = fs::File::create(&tmp)?;
                copy_hashing(&mut entry, &mut out).map_err(|e| {
                    err(
                        ErrorKind::ModelPackageUnpackFailed {
                            detail: e.to_string(),
                        },
                        format!("解压模型失败：{e}"),
                    )
                })
            });
        let spec = match extracted {
            Ok(sha) => candidates.into_iter().find(|s| s.sha256 == sha),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let Some(spec) = spec else {
            let _ = fs::remove_file(&tmp);
            return Err(err(
                ErrorKind::ModelPackageDamaged {
                    file: onnx_name.clone(),
                },
                format!("模型包校验失败：{onnx_name} 已损坏，或不是 Kinshoko 支持的版本"),
            ));
        };
        if sha256_bytes(&tags_csv) != spec.tags_sha256 {
            let _ = fs::remove_file(&tmp);
            return Err(err(
                ErrorKind::ModelPackageTagsMismatch {
                    file: TAGS_FILE.into(),
                    model: spec.label.clone(),
                },
                format!(
                    "模型包里的词表 {TAGS_FILE} 与 {} 不配套（内容、顺序或行数不同）",
                    spec.label
                ),
            ));
        }
        let p = self.paths(spec);
        let installed = (|| {
            fs::create_dir_all(&p.dir)?;
            let _ = fs::remove_file(&p.marker);
            let _ = fs::remove_file(p.onnx.with_extension("part"));
            fs::rename(&tmp, &p.onnx)?;
            fs::write(&p.tags, &tags_csv)?;
            fs::write(&p.marker, &spec.sha256)
        })();
        if let Err(e) = installed {
            let _ = fs::remove_file(&tmp);
            return Err(err(
                ErrorKind::ModelInstallFailed {
                    detail: e.to_string(),
                },
                format!("无法安装模型：{e}"),
            ));
        }
        chunk(spec, &p, &mut |_| {})?;
        self.ready(spec).map(|_| spec.clone()).ok_or_else(|| {
            err(
                ErrorKind::ModelImportIncomplete {
                    model: spec.label.clone(),
                },
                format!("{} 导入后仍不完整", spec.label),
            )
        })
    }
}

const TAGS_FILE: &str = "selected_tags.csv";

/// 词表要有 `name` 与 `category` 两列、至少一行，类别是数字（与打标子进程读词表的规则一致）。
fn check_tags_csv(bytes: &[u8]) -> Result<(), CommandError> {
    let bad = || {
        err(
            ErrorKind::ModelPackageTagsInvalid {
                file: TAGS_FILE.into(),
            },
            format!("模型包里的词表 {TAGS_FILE} 格式不对"),
        )
    };
    let mut reader = csv::Reader::from_reader(bytes);
    let header = reader.headers().map_err(|_| bad())?.clone();
    let column = |name: &str| header.iter().position(|h| h.trim() == name);
    let (Some(name), Some(category)) = (column("name"), column("category")) else {
        return Err(bad());
    };
    let mut rows = 0;
    for record in reader.records() {
        let record = record.map_err(|_| bad())?;
        let ok = record.get(name).is_some_and(|n| !n.is_empty())
            && record
                .get(category)
                .is_some_and(|c| c.trim().parse::<u8>().is_ok());
        if !ok {
            return Err(bad());
        }
        rows += 1;
    }
    if rows == 0 {
        return Err(bad());
    }
    Ok(())
}
