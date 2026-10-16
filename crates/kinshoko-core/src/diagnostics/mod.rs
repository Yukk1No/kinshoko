//! 诊断（#70）：“强制 sRGB”开关的 WebView2 启动参数，以及给画师导出、贴到问题反馈里的诊断日志。
//!
//! 诊断日志只写硬件型号、系统与 WebView2 版本、显示器的色彩状态与 Kinshoko 的诊断开关，
//! **不含文件名、路径与图片**（沿用 Eagle 检查报告的脱敏规则）：系统报来的文字一律经
//! [`scrub`]，像路径或带扩展名的文件名的部分换成 `<路径>`；显示器配置文件只写它自带的名称、
//! 版本与类型，不写文件位置。

mod usage;

use std::fmt::Write as _;

use moxcms::{ColorProfile, ProfileText};

use crate::fidelity::IccKind;
use crate::fidelity::inspect::summarise;

pub use usage::{UsageEvent, UsageLog};

/// Tauri（wry）在没有指定启动参数时给 WebView2 的参数：关掉迷你菜单与 SmartScreen 检查。
/// 自己指定参数时 wry 不再补上，这里照抄（wry 0.57 `webview2/mod.rs`）。
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Chromium 的开关：把显示器当作 sRGB，不按显示器配置文件做色彩管理。
const FORCE_SRGB_ARG: &str = "--force-color-profile=srgb";

/// 本进程所有 WebView2 窗口的启动参数。同一进程里的窗口共用一个 WebView2 环境，
/// 参数必须完全一致，所以只在启动时按设置算一次。
pub fn webview_browser_args(force_srgb: bool) -> String {
    if force_srgb {
        format!("{WRY_DEFAULT_ARGS} {FORCE_SRGB_ARG}")
    } else {
        WRY_DEFAULT_ARGS.to_owned()
    }
}

/// Kinshoko 自身的版本与诊断开关。
#[derive(Debug, Clone)]
pub struct AppFacts {
    pub version: String,
    /// 设置里保存的“强制 sRGB”。
    pub force_srgb: bool,
    /// 本次运行实际采用的“强制 sRGB”。
    pub force_srgb_in_effect: bool,
    pub usage_log: bool,
}

/// 本机的系统、硬件与 WebView2。由应用壳向 Windows 查询后填写。
#[derive(Debug, Clone)]
pub struct SystemFacts {
    /// 例如 `Windows 11 Pro 25H2（26200.9550）`。
    pub windows: String,
    pub cpu: String,
    pub memory_bytes: u64,
    pub gpus: Vec<String>,
    /// WebView2 运行时版本；查询失败时为空。
    pub webview2: Option<String>,
    pub displays: Vec<DisplayFacts>,
}

/// 一台显示器。
#[derive(Debug, Clone)]
pub struct DisplayFacts {
    /// 显示器型号（EDID 里的名称）。
    pub name: String,
    pub primary: bool,
    /// 物理像素。
    pub width: u32,
    pub height: u32,
    /// Windows 缩放比例，1.25 即 125%。
    pub scale: f64,
    pub colour_mode: DisplayColourMode,
    /// 每通道位数；查询不到时为空。
    pub bits_per_channel: Option<u32>,
    /// Windows 为这台显示器设的配置文件字节；没有设时为空。
    pub icc: Option<Vec<u8>>,
}

/// 显示器当前的色彩模式（Windows“高级颜色”）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayColourMode {
    Sdr,
    /// SDR，开着 Windows 自动色彩管理（ACM）。
    AutoColourManagement,
    Hdr,
    Unknown,
}

impl DisplayColourMode {
    fn label(self) -> &'static str {
        match self {
            DisplayColourMode::Sdr => "SDR",
            DisplayColourMode::AutoColourManagement => "SDR（自动色彩管理）",
            DisplayColourMode::Hdr => "HDR",
            DisplayColourMode::Unknown => "未知",
        }
    }
}

/// 生成诊断日志（纯文本，中文）。`generated_at` 为 Unix 秒。
pub fn report(app: &AppFacts, system: &SystemFacts, generated_at: u64) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Kinshoko {} 诊断信息", scrub(&app.version));
    let _ = writeln!(out, "生成时间：{}", utc(generated_at));
    let _ = writeln!(out, "本报告不含文件名、路径与图片。");
    out.push('\n');

    let _ = writeln!(out, "[系统]");
    let _ = writeln!(out, "系统：{}", scrub(&system.windows));
    let _ = writeln!(out, "处理器：{}", scrub(&system.cpu));
    let _ = writeln!(
        out,
        "内存：{:.1} GB",
        system.memory_bytes as f64 / (1u64 << 30) as f64
    );
    if system.gpus.is_empty() {
        let _ = writeln!(out, "显卡：未查询到");
    }
    for gpu in &system.gpus {
        let _ = writeln!(out, "显卡：{}", scrub(gpu));
    }
    let _ = writeln!(
        out,
        "WebView2：{}",
        system
            .webview2
            .as_deref()
            .map(scrub)
            .unwrap_or_else(|| "未查询到".to_owned())
    );
    out.push('\n');

    let _ = writeln!(out, "[显示器]");
    if system.displays.is_empty() {
        let _ = writeln!(out, "未查询到");
    }
    for (i, d) in system.displays.iter().enumerate() {
        let _ = writeln!(
            out,
            "{}. {}{}：{}×{}，缩放 {:.0}%，{}{}",
            i + 1,
            scrub(&d.name),
            if d.primary { "（主显示器）" } else { "" },
            d.width,
            d.height,
            d.scale * 100.0,
            d.colour_mode.label(),
            d.bits_per_channel
                .map(|b| format!("，每通道 {b} 位"))
                .unwrap_or_default(),
        );
        let _ = writeln!(out, "   配置文件：{}", describe_profile(d.icc.as_deref()));
    }
    out.push('\n');

    let _ = writeln!(out, "[Kinshoko 设置]");
    let force = match (app.force_srgb, app.force_srgb_in_effect) {
        (true, true) => "已开启",
        (false, false) => "关闭",
        (true, false) => "已开启，重启后生效",
        (false, true) => "已关闭，重启后生效（本次运行仍强制 sRGB）",
    };
    let _ = writeln!(out, "强制 sRGB：{force}");
    let _ = writeln!(
        out,
        "使用日志：{}",
        if app.usage_log { "开启" } else { "关闭" }
    );
    out
}

/// 显示器配置文件只写它自带的名称、ICC 版本与类型，以及字节的 SHA-256 前 12 位（便于比对）。
fn describe_profile(icc: Option<&[u8]>) -> String {
    let Some(icc) = icc else {
        return "无配置文件（按 sRGB）".to_owned();
    };
    let summary = summarise(icc);
    if summary.kind == IccKind::Invalid {
        return format!("无法解析（{} 字节）", icc.len());
    }
    let name = ColorProfile::new_from_slice(icc)
        .ok()
        .and_then(|p| p.description.as_ref().and_then(profile_text))
        .map(|s| scrub(&s))
        .unwrap_or_else(|| "（无名称）".to_owned());
    let kind = match summary.kind {
        IccKind::Matrix => "矩阵＋曲线",
        IccKind::Lut => "查找表型",
        IccKind::Gray => "灰度",
        IccKind::Invalid => "无法解析",
    };
    format!(
        "{name}，ICC {}，{kind}，SHA-256 {}",
        summary.version,
        &summary.sha256[..12]
    )
}

fn profile_text(text: &ProfileText) -> Option<String> {
    let s = match text {
        ProfileText::PlainString(s) => s.clone(),
        ProfileText::Localizable(list) => list.first()?.value.clone(),
        ProfileText::Description(d) => d.ascii_string.clone(),
    };
    let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!s.is_empty()).then(|| s.to_owned())
}

/// 系统报来的文字去掉控制字符；从第一个像路径或文件名的词起，到行尾都换成 `<路径>`。
pub fn scrub(text: &str) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out = String::new();
    for word in clean.split_whitespace() {
        if looks_like_path(word) {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str("<路径>");
            return out;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// 带目录分隔符、盘符、URL 协议，或以“.字母开头的扩展名”结尾的词。
fn looks_like_path(word: &str) -> bool {
    if word.contains('\\') || word.contains('/') || word.contains("://") {
        return true;
    }
    let bytes = word.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    match word.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.starts_with(|c: char| c.is_ascii_alphabetic())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Unix 秒 → `YYYY-MM-DD hh:mm:ss UTC`。
fn utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 days_from_civil 逆算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
