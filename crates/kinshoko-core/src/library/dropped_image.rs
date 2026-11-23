use std::io::Write;
use std::path::{Path, PathBuf};

use crate::CommandError;
use crate::command_error::ErrorKind;

/// Stage browser-provided image bytes for the ordinary import dialog.
pub fn stage_dropped_image(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, CommandError> {
    let image = crate::fidelity::inspect::inspect(bytes)
        .map_err(|detail| {
            CommandError::new(
                ErrorKind::ImageDecode {
                    detail: detail.clone(),
                },
                detail,
            )
        })?
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::DroppedImageUnsupported,
                "Unsupported dropped image format",
            )
        })?;
    image::load_from_memory_with_format(bytes, image.format).map_err(|e| {
        CommandError::new(
            ErrorKind::ImageDecode {
                detail: e.to_string(),
            },
            e.to_string(),
        )
    })?;
    let extension = match image.format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::WebP => "webp",
        _ => {
            return Err(CommandError::new(
                ErrorKind::DroppedImageUnsupported,
                "Unsupported dropped image format",
            ));
        }
    };
    let name = safe_stem(name);
    std::fs::create_dir_all(dir).map_err(CommandError::system)?;
    super::forget_staged_clipboard_images(dir);
    for attempt in 0u64.. {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let path = dir.join(format!("{name}{suffix}.{extension}"));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(CommandError::system(e)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(CommandError::system(error));
        }
        return Ok(path);
    }
    unreachable!()
}

fn safe_stem(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = leaf.rsplit_once('.').map_or(leaf, |(stem, _)| stem);
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .scan(0, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= 160).then_some(c)
        })
        .collect();
    let clean = clean.trim_matches([' ', '.']);
    let device = clean
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            device.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if clean.is_empty() {
        "image".into()
    } else if reserved {
        format!("_{clean}")
    } else {
        clean.into()
    }
}
