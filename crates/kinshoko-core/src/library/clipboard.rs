//! 复制图片、在资源管理器中显示、从剪贴板导入（#102 T3，#105）。
//!
//! 三条命令共用的部分：经浏览视角取得原图（不存在、被封印都当作没有这张图），原文件缺失时
//! 报告缺的是哪个文件，不静默失败。系统剪贴板与资源管理器由应用壳接上。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::{ExtendedColorType, ImageEncoder, RgbaImage, codecs::png::PngEncoder};

use super::{Error, Library};

/// 暂存的剪贴板图片保留多久：导入（含失败重试）早已读完它。
const STAGED_KEEP: Duration = Duration::from_secs(24 * 60 * 60);

impl Library {
    /// 复制图片：原图的像素，原尺寸、按方向转正，转换为不带配置文件的 sRGB RGBA8（剪贴板图片
    /// 不能携带 ICC），与钉图“复制”同一条显示管线。动图取首帧，HDR 经色调映射。
    pub fn clipboard_pixels(&self, image_id: &str) -> Result<RgbaImage, Error> {
        let original = self.reveal_original(image_id)?;
        let display = self.display(image_id)?;
        let bytes = std::fs::read(&display.path).map_err(|e| missing_or(e, &original))?;
        crate::fidelity::render::clipboard_rgba(&bytes).map_err(Error::Undecodable)
    }

    /// 在资源管理器中显示：原文件的位置。文件已不在（被移走或删除）时为
    /// [`Error::OriginalMissing`]，界面据此提示，不打开一个找不到文件的窗口。
    pub fn reveal_original(&self, image_id: &str) -> Result<PathBuf, Error> {
        let path = self.original_path(image_id)?;
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => Ok(path),
            Ok(_) => Err(Error::OriginalMissing(path)),
            Err(e) => Err(missing_or(e, &path)),
        }
    }
}

fn missing_or(error: std::io::Error, path: &Path) -> Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        Error::OriginalMissing(path.to_owned())
    } else {
        Error::Io(error)
    }
}

/// 从剪贴板导入：把剪贴板里的图片（按 sRGB 解释）写成 `dir` 下一个新的无损 PNG，交给普通导入，
/// 保存位置照常由画师选择。每次粘贴一个新文件；一天前暂存的文件顺手清掉。失败时不留下文件。
pub fn stage_clipboard_image(dir: &Path, image: &RgbaImage) -> Result<PathBuf, Error> {
    if image.width() == 0 || image.height() == 0 {
        return Err(Error::ClipboardImage("图片是空的".into()));
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| Error::ClipboardImage(e.to_string()))?;
    std::fs::create_dir_all(dir)?;
    forget_staged_clipboard_images(dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    for attempt in 0u32.. {
        let name = if attempt == 0 {
            format!("剪贴板图片-{stamp}.png")
        } else {
            format!("剪贴板图片-{stamp}-{attempt}.png")
        };
        let path = dir.join(name);
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        if let Err(e) = file.write_all(&png).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(e.into());
        }
        return Ok(path);
    }
    unreachable!("文件名尝试不会用完")
}

/// 清掉暂存目录里一天前的剪贴板图片；清不掉的留到下次。每次暂存时顺手清一次，应用壳在启动时
/// 也单独清一次：画师取消了保存位置、或之后再没粘贴过，暂存的图（可能是敏感内容）也不会一直留着。
/// 暂存的文件不在导入用过后立即删掉：失败重试还会从同一路径再读。目录不存在时什么也不做。
pub fn forget_staged_clipboard_images(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STAGED_KEEP);
        if old && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
