//! pixiv 图片转发（#461）：`i.pximg.net` 不带 pixiv 的 Referer 时回 403（#367），界面不能直接显示，
//! 由后端带上 Referer 去取，存进磁盘缓存再交给界面。
//!
//! 缩略图走 CDN，只限同时几张；原图按订阅来源的下载节拍排队，排在后台检查前面。

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use super::api::{APP_UA, agent};
use crate::subscription::SourceError;
use crate::subscription::image_cache::{ImageCache, mime};
use crate::subscription::pace::{Pacers, Priority};

/// pixiv 的图片主机。只转发这里的图。
pub const IMAGE_HOST: &str = "https://i.pximg.net/";
/// `i.pximg.net` 的原图不带 pixiv 的 Referer 时回 403（#367 实测）。
const IMAGE_REFERER: &str = "https://app-api.pixiv.net/";
/// 单张原图的上限：pixiv 原图最大约 50 MB，超过的多半不是图。
const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;

/// 带上 Referer 取一张 pixiv 图。
pub(super) fn fetch(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, SourceError> {
    let response = agent
        .get(url)
        .set("Referer", IMAGE_REFERER)
        .set("User-Agent", APP_UA)
        .call();
    match response {
        Ok(r) => {
            let mut bytes = Vec::new();
            r.into_reader()
                .take(MAX_IMAGE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| SourceError::Network)?;
            if bytes.len() as u64 > MAX_IMAGE_BYTES {
                return Err(SourceError::Unreadable);
            }
            Ok(bytes)
        }
        Err(ureq::Error::Status(429, _)) => Err(SourceError::RateLimited),
        Err(ureq::Error::Status(status, _)) => Err(SourceError::Status { status }),
        Err(ureq::Error::Transport(_)) => Err(SourceError::Network),
    }
}

/// 转发出去的一张图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// 界面要的图是哪一张：图片主机后面的路径，例如 `c/540x540_70/img-master/img/…_p0_master1200.jpg`。
/// 认不出时为空。
fn image_url(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    let ok = !path.is_empty()
        && path.len() <= 512
        && !path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'.'));
    ok.then(|| format!("{IMAGE_HOST}{path}"))
}

/// 原图在 `img-original/` 下；其余（`img-master`、`c/…` 缩放过的、头像）按缩略图对待。
fn is_original(path: &str) -> bool {
    path.trim_start_matches('/').starts_with("img-original/")
}

/// pixiv 图片转发：缓存、节拍与下载。
pub struct PixivImages {
    agent: ureq::Agent,
    pacers: Arc<Pacers>,
    cache: ImageCache,
}

impl PixivImages {
    /// `pacers` 是 pixiv 共用的一份节拍。
    pub fn new(pacers: Arc<Pacers>, cache: ImageCache) -> PixivImages {
        PixivImages {
            agent: agent(),
            pacers,
            cache,
        }
    }

    /// 取图片主机上 `path` 这张图：缓存里有就不联网。`cancel` 置位时不再发请求。
    pub fn get(&self, path: &str, cancel: &AtomicBool) -> Result<Image, SourceError> {
        self.get_with(path, cancel, &mut |url| fetch(&self.agent, url))
    }

    fn get_with(
        &self,
        path: &str,
        cancel: &AtomicBool,
        fetch: &mut dyn FnMut(&str) -> Result<Vec<u8>, SourceError>,
    ) -> Result<Image, SourceError> {
        let url = image_url(path).ok_or(SourceError::Unsupported)?;
        if let Some(bytes) = self.cache.get(&url) {
            return Ok(Image {
                mime: mime(&bytes),
                bytes,
            });
        }
        let bytes = if is_original(path) {
            if !self.pacers.download(Priority::Foreground, cancel) {
                return Err(SourceError::Cancelled);
            }
            fetch(&url)?
        } else {
            let Some(_slot) = self.pacers.thumbnails.take(cancel) else {
                return Err(SourceError::Cancelled);
            };
            fetch(&url)?
        };
        let mime = mime(&bytes);
        if mime == "application/octet-stream" {
            return Err(SourceError::Unreadable);
        }
        if let Err(e) = self.cache.put(&url, &bytes) {
            // 不上界面：缓存写不进去只影响下次要不要重新下载。
            eprintln!("pixiv 图片缓存写不进去：{e}");
        }
        Ok(Image { bytes, mime })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::image_cache::IMAGE_CACHE_BYTES;

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    #[test]
    fn only_paths_on_the_image_host_are_forwarded() {
        assert_eq!(
            image_url("/c/540x540_70/img-master/img/2024/03/01/09/00/00/5_p0_master1200.jpg")
                .as_deref(),
            Some(
                "https://i.pximg.net/c/540x540_70/img-master/img/2024/03/01/09/00/00/5_p0_master1200.jpg"
            )
        );
        for bad in [
            "",
            "/",
            "img-original/../x.png",
            "a//b.jpg",
            "@example.com/a.jpg",
            "a.jpg?x=1",
            "a b.jpg",
        ] {
            assert_eq!(image_url(bad), None, "{bad}");
        }
        assert!(is_original("/img-original/img/5_p0.png"));
        assert!(!is_original("/c/540x540_70/img-master/img/5_p0.jpg"));
    }

    #[test]
    fn images_are_fetched_once_then_served_from_cache() {
        let dir = tempfile::tempdir().unwrap();
        let images = PixivImages::new(
            Arc::new(Pacers::default()),
            ImageCache::new(dir.path(), IMAGE_CACHE_BYTES),
        );
        let cancel = AtomicBool::new(false);
        let mut asked = Vec::new();
        let mut fetch = |url: &str| {
            asked.push(url.to_owned());
            Ok(JPEG.to_vec())
        };
        let path = "c/540x540_70/img-master/5_p0.jpg";
        for _ in 0..2 {
            let image = images.get_with(path, &cancel, &mut fetch).unwrap();
            assert_eq!(image.mime, "image/jpeg");
            assert_eq!(image.bytes, JPEG);
        }
        assert_eq!(asked, [format!("{IMAGE_HOST}{path}")]);

        // 回来的不是图（例如错误页）时不存，下次再试。
        let mut html = |_: &str| Ok(b"<html>".to_vec());
        assert_eq!(
            images.get_with("c/x/6_p0.jpg", &cancel, &mut html),
            Err(SourceError::Unreadable)
        );
        assert_eq!(
            images.get_with("../6_p0.jpg", &cancel, &mut html),
            Err(SourceError::Unsupported)
        );
    }
}
