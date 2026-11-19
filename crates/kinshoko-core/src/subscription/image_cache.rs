//! 远端图片的磁盘缓存（#461）：应用内浏览看过的缩略图与原图存在这里，超过上限时先删最久没用的。
//! 缓存里的图不在资料库里，删掉随时可以重新下载。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// 缓存默认的上限。
pub const IMAGE_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

/// 一个按地址存图的磁盘缓存。
#[derive(Debug)]
pub struct ImageCache {
    dir: PathBuf,
    cap: u64,
    /// 缓存里现有多少字节；第一次写入时数一遍。
    size: Mutex<Option<u64>>,
}

impl ImageCache {
    pub fn new(dir: impl Into<PathBuf>, cap: u64) -> ImageCache {
        ImageCache {
            dir: dir.into(),
            cap,
            size: Mutex::new(None),
        }
    }

    fn file(&self, key: &str) -> PathBuf {
        let hash = Sha256::digest(key.as_bytes());
        let name: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join(name)
    }

    /// 缓存过的图。读到时记为刚用过。
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.file(key);
        let bytes = fs::read(&path).ok()?;
        if let Ok(file) = fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    /// 存一张图；超过上限时删掉最久没用的，删到上限的九成。
    pub fn put(&self, key: &str, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() as u64 > self.cap {
            return Ok(());
        }
        fs::create_dir_all(&self.dir)?;
        let path = self.file(key);
        let tmp = self.dir.join(format!("{}.part", uuid::Uuid::new_v4()));
        fs::write(&tmp, bytes)?;
        // 换文件和记账在同一把锁里：同一张图被两个请求同时存时，后一次替换前一次，只记一份。
        let mut size = self.size.lock().unwrap_or_else(|e| e.into_inner());
        let replaced = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if let Err(e) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        let total = match *size {
            Some(total) => (total + bytes.len() as u64).saturating_sub(replaced),
            None => entries(&self.dir).iter().map(|e| e.1).sum(),
        };
        *size = Some(if total > self.cap {
            trim(&self.dir, self.cap / 10 * 9)
        } else {
            total
        });
        Ok(())
    }
}

/// 缓存里的图：路径、字节数、上次用的时间。写了一半的不算。
fn entries(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.flatten()
        .filter(|e| e.path().extension().is_none())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| {
                let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                (e.path(), meta.len(), used)
            })
        })
        .collect()
}

/// 从最久没用的删起，删到不超过 `keep`；返回剩下的字节数。
fn trim(dir: &Path, keep: u64) -> u64 {
    let mut entries = entries(dir);
    entries.sort_by_key(|e| e.2);
    let mut total: u64 = entries.iter().map(|e| e.1).sum();
    for (path, len, _) in entries {
        if total <= keep {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
    total
}

/// 从文件头认出图片格式，给转发回应的 Content-Type。
pub fn mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stores_and_reads_back_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(dir.path().join("cache"), 1024);
        assert_eq!(cache.get("a"), None);
        cache.put("a", b"one").unwrap();
        assert_eq!(cache.get("a").as_deref(), Some(&b"one"[..]));
        cache.put("a", b"two").unwrap();
        assert_eq!(cache.get("a").as_deref(), Some(&b"two"[..]));
        // 太大的图不存。
        cache.put("big", &[0; 2048]).unwrap();
        assert_eq!(cache.get("big"), None);
    }

    #[test]
    fn over_the_cap_the_least_recently_used_go_first() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(dir.path(), 300);
        let old = SystemTime::now() - Duration::from_secs(3600);
        for key in ["a", "b", "c"] {
            cache.put(key, &[0; 100]).unwrap();
            fs::File::options()
                .write(true)
                .open(cache.file(key))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        // 用过 a，它变成最近用的；再存 d 时超过上限，删到 270 以下：先删 b、c。
        assert!(cache.get("a").is_some());
        cache.put("d", &[0; 100]).unwrap();
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_none());
        assert!(cache.get("d").is_some());
    }

    #[test]
    fn storing_the_same_image_again_is_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(dir.path(), 100);
        // 实际 95 字节，没到上限；同一张图重复存时若重复记账，会以为超了上限而删图。
        for key in ["a", "b", "c", "d", "e", "f", "g", "h"] {
            cache.put(key, &[0; 10]).unwrap();
        }
        cache.put("i", &[0; 15]).unwrap();
        cache.put("a", &[0; 10]).unwrap();
        cache.put("a", &[0; 10]).unwrap();
        for key in ["a", "b", "c", "d", "e", "f", "g", "h", "i"] {
            assert!(cache.get(key).is_some(), "{key} 不该被删");
        }
    }

    #[test]
    fn formats_are_sniffed() {
        assert_eq!(mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(mime(b"\x89PNG\r\n"), "image/png");
        assert_eq!(mime(b"RIFF\0\0\0\0WEBPVP8"), "image/webp");
        assert_eq!(mime(b"<html>"), "application/octet-stream");
    }
}
