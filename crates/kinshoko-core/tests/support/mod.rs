//! 测试用的本地模型下载服务：在 127.0.0.1 上按 `/{repo}/resolve/{revision}/{file}`
//! 提供内存中的文件，支持 `Range: bytes=N-` 续传，也能在发出若干字节后掐断连接，
//! 模拟网络中断。测试与 CI 从不下载真模型。

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use kinshoko_core::tagging::{Device, ModelSpec};
use sha2::{Digest, Sha256};

#[derive(Default)]
struct Shared {
    files: HashMap<String, Vec<u8>>,
    /// 路径 → 下一次响应只发出这么多字节就断开（一次性）。
    cut_after: HashMap<String, usize>,
    /// 收到的请求：路径与 Range 起点。
    requests: Vec<(String, Option<u64>)>,
}

pub struct ModelServer {
    base: String,
    shared: Arc<Mutex<Shared>>,
}

pub fn sha256(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// PixAI 风格的标签表（只保留测试用到的几行）。
pub const TAGS_CSV: &str = "tag_id,name,category,count\n\
0,blue_eyes,0,100\n1,long_hair,0,100\n2,hatsune_miku,4,10\n\
3,general,9,1\n4,sensitive,9,1\n5,questionable,9,1\n6,explicit,9,1\n";

impl ModelServer {
    pub fn start() -> ModelServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(Mutex::new(Shared::default()));
        let s = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = s.clone();
                std::thread::spawn(move || serve(stream, &s));
            }
        });
        ModelServer { base, shared }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn put(&self, path: &str, data: &[u8]) {
        self.lock().files.insert(path.to_owned(), data.to_vec());
    }

    /// 下一次请求 `path` 时只发出 `n` 字节就断开。
    pub fn cut_next(&self, path: &str, n: usize) {
        self.lock().cut_after.insert(path.to_owned(), n);
    }

    pub fn requests(&self) -> Vec<(String, Option<u64>)> {
        self.lock().requests.clone()
    }

    /// 发布一个不分块的测试模型（内容 `model`）及标签表，返回对应的模型规格。
    pub fn publish(&self, key: &str, device: Device, model: &[u8]) -> ModelSpec {
        let spec = test_spec(key, device, model);
        self.put(&model_path(&spec, &spec.file), model);
        self.put(&model_path(&spec, &spec.tags_file), TAGS_CSV.as_bytes());
        spec
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap()
    }
}

pub fn model_path(spec: &ModelSpec, file: &str) -> String {
    format!("/{}/resolve/{}/{}", spec.repo, spec.revision, file)
}

/// 测试模型规格：阈值沿用 PixAI v1.0 模型卡，分级在第 9 类。
pub fn test_spec(key: &str, device: Device, model: &[u8]) -> ModelSpec {
    ModelSpec {
        key: key.into(),
        label: format!("测试模型 {key}"),
        source: "test-tagger".into(),
        repo: format!("test/{key}"),
        revision: "0123456789abcdef".into(),
        file: "model.onnx".into(),
        size: model.len() as u64,
        sha256: sha256(model),
        tags_file: "selected_tags.csv".into(),
        chunking: None,
        device,
        vram_need: 1_800_000_000,
        ram_need: 0,
        thresholds: vec![(0, 0.17), (1, 0.15), (3, 0.24), (4, 0.27), (5, 0.17), (9, 0.41)],
        rating_category: Some(9),
    }
}

fn serve(mut stream: TcpStream, shared: &Mutex<Shared>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let path = first.split_whitespace().nth(1).unwrap_or("").to_owned();
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("range: bytes=") {
            range = v.trim().trim_end_matches('-').parse::<u64>().ok();
        }
    }
    let (data, cut) = {
        let mut s = shared.lock().unwrap();
        s.requests.push((path.clone(), range));
        let cut = s.cut_after.remove(&path);
        (s.files.get(&path).cloned(), cut)
    };
    let Some(data) = data else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let start = range.unwrap_or(0).min(data.len() as u64) as usize;
    let body = &data[start..];
    let head = if range.is_some() {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
            body.len(),
            start,
            data.len().saturating_sub(1),
            data.len()
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
    };
    let _ = stream.write_all(head.as_bytes());
    let body = match cut {
        Some(n) => &body[..n.min(body.len())],
        None => body,
    };
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
