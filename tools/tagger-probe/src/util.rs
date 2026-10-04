use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

pub fn sha256_bytes(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// Percentile of an already sorted slice (nearest-rank).
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

static LOG: std::sync::Mutex<Option<File>> = std::sync::Mutex::new(None);

/// Also append everything `say!` prints to `path`, so a run that crashes leaves a trace.
pub fn set_log(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        *LOG.lock().unwrap() = Some(f);
    }
}

/// Replace the user's profile paths in a message, so reports never carry the account name.
pub fn scrub(msg: &str) -> String {
    let mut out = msg.to_string();
    for var in ["LOCALAPPDATA", "APPDATA", "USERPROFILE"] {
        let Some(dir) = std::env::var_os(var) else { continue };
        let dir = dir.to_string_lossy().to_string();
        if dir.len() < 4 {
            continue;
        }
        // Windows paths are case-insensitive; match on a lowercased copy.
        let mut lower = out.to_lowercase();
        let needle = dir.to_lowercase();
        while let Some(i) = lower.find(&needle) {
            out.replace_range(i..i + dir.len(), &format!("%{var}%"));
            lower = out.to_lowercase();
        }
    }
    out
}

pub fn log_line(line: &str) {
    let line = &scrub(line);
    println!("{line}");
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

/// `println!` that is also written to the run log.
macro_rules! say {
    ($($t:tt)*) => { $crate::util::log_line(&format!($($t)*)) };
}
