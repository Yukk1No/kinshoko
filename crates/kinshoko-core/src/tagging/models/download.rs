//! 下载模型文件：断点续传，出错时给出错误代码。

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

/// 下载失败的原因。不写下载地址：仓库名与文件名带精度字样，画师用不上（#143）。
fn download_error(error: ureq::Error) -> CommandError {
    match error {
        ureq::Error::Status(status, _) => err(
            ErrorKind::DownloadRefused { status },
            format!("下载失败：服务器返回 {status}"),
        ),
        ureq::Error::Transport(transport) => {
            let detail = match transport.message() {
                Some(message) => format!("{} ({message})", transport.kind()),
                None => transport.kind().to_string(),
            };
            err(
                ErrorKind::DownloadFailed {
                    detail: detail.clone(),
                },
                format!("下载失败：{detail}"),
            )
        }
    }
}

pub(super) fn dir_failed(e: std::io::Error) -> CommandError {
    err(
        ErrorKind::ModelDirFailed {
            detail: e.to_string(),
        },
        format!("无法建立模型目录：{e}"),
    )
}

fn download_interrupted(e: std::io::Error) -> CommandError {
    err(
        ErrorKind::DownloadInterrupted {
            detail: e.to_string(),
        },
        format!("下载中断：{e}"),
    )
}

/// 把 `url` 下载到 `dest`：先写 `.part`，有旧的 `.part` 时用 `Range` 续传，完整后改名。
pub(super) fn download(
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    progress: &mut dyn FnMut(PrepareStage),
    cancel: &AtomicBool,
) -> Result<(), CommandError> {
    let part = dest.with_extension("part");
    let mut have = file_len(&part).unwrap_or(0);
    if let Some(size) = expected_size {
        if have == size {
            // 上次下完但没来得及改名；随后的哈希校验兜底。
            return Ok(fs::rename(&part, dest)?);
        }
        if have > size {
            let _ = fs::remove_file(&part);
            have = 0;
        }
    }
    let mut req = ureq::get(url).set("User-Agent", "kinshoko");
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(download_error)?;
    let resumed = resp.status() == 206;
    let total = expected_size.or_else(|| {
        resp.header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| if resumed { n + have } else { n })
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)?;
    let mut done = if resumed { have } else { 0 };
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    let mut last_report = 0u64;
    progress(PrepareStage::Downloading {
        downloaded: done,
        total: total.unwrap_or(0),
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(err(ErrorKind::DownloadStopped, "下载已停止"));
        }
        let n = reader.read(&mut buf).map_err(download_interrupted)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if done - last_report >= 1 << 20 || Some(done) == total {
            last_report = done;
            progress(PrepareStage::Downloading {
                downloaded: done,
                total: total.unwrap_or(0),
            });
        }
    }
    file.flush()?;
    drop(file);
    if let Some(total) = total
        && done != total
    {
        return Err(err(
            ErrorKind::DownloadIncomplete { done, total },
            format!("下载中断：只收到 {done} / {total} 字节"),
        ));
    }
    Ok(fs::rename(&part, dest)?)
}
