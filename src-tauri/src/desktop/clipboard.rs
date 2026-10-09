//! Prepare image formats before acquiring visibility authority or opening the OS clipboard.
//! The irreversible commit starts when Windows clears the previous contents.
use image::RgbaImage;
use tauri::AppHandle;

pub(super) struct PreparedImage {
    #[cfg(windows)]
    png: Vec<u8>,
    #[cfg(windows)]
    dibv5: Vec<u8>,
    #[cfg(not(windows))]
    image: RgbaImage,
}

impl PreparedImage {
    pub(super) fn prepare(image: &RgbaImage) -> Result<Self, String> {
        #[cfg(debug_assertions)]
        let started = std::time::Instant::now();
        if image.width() == 0 || image.height() == 0 {
            return Err("复制的图片是空的".into());
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "clipboard.prepare.begin at={} size={}x{}",
            now_ms(),
            image.width(),
            image.height()
        );
        #[cfg(windows)]
        let prepared = {
            use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
            let dibv5 = dibv5(image)?;
            let mut png = Vec::new();
            PngEncoder::new(&mut png)
                .write_image(
                    image.as_raw(),
                    image.width(),
                    image.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|error| format!("无法准备复制的图片：{error}"))?;
            Self { png, dibv5 }
        };
        #[cfg(not(windows))]
        let prepared = Self {
            image: image.clone(),
        };
        #[cfg(debug_assertions)]
        eprintln!(
            "clipboard.prepare.end at={} ms={} size={}x{}",
            now_ms(),
            started.elapsed().as_millis(),
            image.width(),
            image.height()
        );
        Ok(prepared)
    }

    /// Caller has revalidated its authority and holds the final visibility permit.
    /// Encoding and pixel conversion have finished. Opening failure preserves the old contents.
    /// After the first OS set starts, Windows has no transaction to roll back both formats.
    pub(super) fn commit(self, app: &AppHandle) -> Result<(), String> {
        #[cfg(debug_assertions)]
        let started = std::time::Instant::now();
        #[cfg(debug_assertions)]
        eprintln!("clipboard.commit.begin at={}", now_ms());
        #[cfg(windows)]
        {
            use tauri::Manager;
            let window = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next())
                .ok_or("没有可用于复制的程序窗口")?;
            let owner = window
                .hwnd()
                .map_err(|error| format!("无法打开剪贴板：{error}"))?;
            let png_format =
                clipboard_win::register_format("PNG").ok_or("无法登记图片剪贴板格式")?;
            let _clipboard = clipboard_win::Clipboard::new_attempts_for(owner.0, 10)
                .map_err(|error| format!("无法打开剪贴板：{error}"))?;
            // set allocates and copies the first payload BEFORE clearing. Keep PNG first,
            // as in arboard: consumers may select the first available format.
            clipboard_win::raw::set(png_format.get(), &self.png)
                .map_err(|error| format!("无法写入剪贴板：{error}"))?;
            clipboard_win::raw::set_without_clear(clipboard_win::formats::CF_DIBV5, &self.dibv5)
                .map_err(|error| format!("图片已复制，但部分程序可能无法粘贴：{error}"))?;
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            arboard::Clipboard::new()
                .and_then(|mut clipboard| {
                    clipboard.set_image(arboard::ImageData {
                        width: self.image.width() as usize,
                        height: self.image.height() as usize,
                        bytes: self.image.as_raw().into(),
                    })
                })
                .map_err(|error| format!("无法写入剪贴板：{error}"))?;
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "clipboard.commit.end at={} ms={}",
            now_ms(),
            started.elapsed().as_millis()
        );
        Ok(())
    }
}

#[cfg(debug_assertions)]
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
fn dibv5(image: &RgbaImage) -> Result<Vec<u8>, String> {
    const HEADER: usize = 124;
    let width = i32::try_from(image.width()).map_err(|_| "复制的图片太宽")?;
    let height = i32::try_from(image.height()).map_err(|_| "复制的图片太高")?;
    let byte_count = u32::try_from(image.as_raw().len()).map_err(|_| "复制的图片太大")?;
    let length = HEADER
        .checked_add(byte_count as usize)
        .ok_or("复制的图片太大")?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "无法为复制的图片分配内存")?;
    bytes.resize(length, 0);
    // BITMAPV5HEADER, little-endian, 32-bit BI_BITFIELDS, sRGB, straight alpha.
    // Positive height and bottom-up BGRA preserve interoperability with older consumers.
    // https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapv5header
    for (offset, value) in [
        (0, HEADER as u32),
        (4, width as u32),
        (8, height as u32),
        (16, 3),
        (20, byte_count),
        (40, 0x00ff_0000),
        (44, 0x0000_ff00),
        (48, 0x0000_00ff),
        (52, 0xff00_0000),
        (56, 0x7352_4742),
        (108, 4),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[12..14].copy_from_slice(&1_u16.to_le_bytes());
    bytes[14..16].copy_from_slice(&32_u16.to_le_bytes());
    let row_bytes = image.width() as usize * 4;
    for (to, from) in bytes[HEADER..]
        .chunks_exact_mut(row_bytes)
        .zip(image.as_raw().rchunks_exact(row_bytes))
    {
        for (to, from) in to.chunks_exact_mut(4).zip(from.chunks_exact(4)) {
            to.copy_from_slice(&[from[2], from[1], from[0], from[3]]);
        }
    }
    Ok(bytes)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn prepared_formats_keep_transparent_rgb_alpha_and_bottom_up_orientation() {
        let image = RgbaImage::from_fn(3, 2, |x, y| {
            image::Rgba([
                (x * 30 + y) as u8,
                (y * 40 + x) as u8,
                91,
                [0, 80, 255][x as usize],
            ])
        });
        let prepared = PreparedImage::prepare(&image).unwrap();
        assert_eq!(
            image::load_from_memory(&prepared.png).unwrap().to_rgba8(),
            image
        );
        // An independent BMP decoder consumes the public DIBV5 bytes; no OS clipboard is touched.
        let file_size = u32::try_from(prepared.dibv5.len() + 14).unwrap();
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&file_size.to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&(14_u32 + 124).to_le_bytes());
        bmp.extend_from_slice(&prepared.dibv5);
        assert_eq!(
            image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp)
                .unwrap()
                .to_rgba8(),
            image
        );
    }
}
