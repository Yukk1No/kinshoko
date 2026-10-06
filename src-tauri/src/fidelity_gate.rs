//! 还原度门槛实验（#45）：`kinshoko.exe --fidelity-gate [报告目录] [--exit]`。
//!
//! 在报告目录下新建一个只放门槛样本的资料库（不碰画师的资料库），打开窗口
//! `fidelity-gate`，由 WebView2 自己解码原图与缩略图、读回 `display-p3` canvas 比较色块
//! ΔE2000，并把结果与本机环境（GPU、驱动、Windows、WebView2 版本、显示器 ICC、HDR 与
//! 自动色彩管理状态）写成 JSON 与 Markdown 报告。带 `--exit` 时保存后退出，退出码表示是否通过，
//! 供 CI 使用。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use kinshoko_core::fidelity::gate::{self, GatePlan};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const ARG: &str = "--fidelity-gate";
const EXIT_ARG: &str = "--exit";
const WINDOW: &str = "fidelity-gate";

/// 门槛实验的参数：报告目录与是否保存后退出。没有 `--fidelity-gate` 时为 `None`。
pub struct Options {
    pub report_dir: Option<PathBuf>,
    pub exit: bool,
}

pub fn options(args: &[String]) -> Option<Options> {
    let at = args.iter().position(|a| a == ARG)?;
    let report_dir = args
        .get(at + 1)
        .filter(|a| !a.starts_with("--"))
        .map(PathBuf::from);
    Some(Options {
        report_dir,
        exit: args.iter().any(|a| a == EXIT_ARG),
    })
}

struct Prepared {
    run: gate::GateRun,
    report_dir: PathBuf,
    environment: serde_json::Value,
}

#[derive(Default)]
pub struct GateState {
    slot: Mutex<Option<Result<Arc<Prepared>, String>>>,
    ready: Condvar,
    exit: Mutex<bool>,
}

impl GateState {
    fn wait(&self) -> Result<Arc<Prepared>, String> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(result) = slot.as_ref() {
                return result.clone();
            }
            slot = self.ready.wait(slot).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// 准备样本库（后台线程）并打开门槛实验窗口。
pub fn start(app: &AppHandle, options: Options) {
    let state = app.state::<GateState>();
    *state.exit.lock().unwrap_or_else(|e| e.into_inner()) = options.exit;
    *state.slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let report_dir = options.report_dir.unwrap_or_else(|| {
        app.path()
            .desktop_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Kinshoko 还原度报告")
    });
    let handle = app.clone();
    std::thread::Builder::new()
        .name("kinshoko-fidelity-gate".into())
        .spawn(move || {
            let result = prepare(&report_dir).map(Arc::new);
            let state = handle.state::<GateState>();
            *state.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
            state.ready.notify_all();
        })
        .expect("无法启动门槛实验线程");

    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
    if let Err(e) = WebviewWindowBuilder::new(
        app,
        WINDOW,
        WebviewUrl::App("index.html#fidelity-gate".into()),
    )
    .title("Kinshoko 还原度门槛实验")
    .inner_size(1100.0, 800.0)
    .build()
    {
        eprintln!("打开门槛实验窗口失败：{e}");
    }
}

fn prepare(report_dir: &Path) -> Result<Prepared, String> {
    let stamp = chrono_stamp();
    let dir = report_dir.join(format!("run-{stamp}"));
    let run = gate::prepare(&dir).map_err(|e| e.to_string())?;
    Ok(Prepared {
        run,
        report_dir: report_dir.to_path_buf(),
        environment: environment(),
    })
}

/// 本地时间戳，用于目录与报告文件名（不依赖时区库：取 UTC）。
fn chrono_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // 1970-01-01 起的天数 → 公历日期（Howard Hinnant 的算法）。
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// 本机环境：WebView2 版本，以及经 PowerShell 读到的 Windows、GPU 与驱动、显示器 ICC 关联。
/// HDR 与自动色彩管理没有可靠的无 FFI 读取方式，由页面的媒体查询与画师填写补齐。
fn environment() -> serde_json::Value {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object DisplayVersion, CurrentBuild, UBR
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentBitsPerPixel)
$mon = @(Get-CimInstance -Namespace root\wmi WmiMonitorID | ForEach-Object {
  [pscustomobject]@{
    Instance = $_.InstanceName
    Name = (($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '')
  } })
$icm = @()
foreach ($root in 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\ICM\ProfileAssociations\Display', 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ICM\ProfileAssociations\Display') {
  Get-ChildItem $root -Recurse | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.ICMProfile -or $p.ICMProfileAC) {
      $icm += [pscustomobject]@{ Key = $_.Name; ICMProfile = $p.ICMProfile; ICMProfileAC = $p.ICMProfileAC; UsePerUserProfiles = $p.UsePerUserProfiles }
    }
  }
}
$json = [pscustomobject]@{ os = $os; windows = $cv; gpus = $gpu; monitors = $mon; icmAssociations = $icm } | ConvertTo-Json -Depth 5 -Compress
# 非 ASCII 字符转成 \uXXXX，输出与控制台代码页无关。
[regex]::Replace($json, '[^\x00-\x7f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
"#;
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：release 构建没有控制台，不要弹出 PowerShell 窗口。
        command.creation_flags(0x0800_0000);
    }
    let system = command
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "webview2": tauri::webview_version().unwrap_or_else(|e| format!("未知（{e}）")),
        "kinshoko": env!("CARGO_PKG_VERSION"),
        "system": system,
    })
}

/// 等样本库准备好后返回实验计划。
#[tauri::command]
pub async fn gate_plan(app: AppHandle) -> Result<GatePlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GateState>();
        let prepared = state.wait()?;
        let auto_save = *state.exit.lock().unwrap_or_else(|e| e.into_inner());
        Ok(GatePlan {
            items: prepared.run.items.clone(),
            environment: prepared.environment.clone(),
            library: prepared.run.library.info().root.clone(),
            auto_save,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 样本原文件（`px` 为空）或其缩略图的字节，原样交给 WebView2 解码。
#[tauri::command]
pub async fn gate_image(
    app: AppHandle,
    image_id: String,
    px: Option<u32>,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = app.state::<GateState>().wait()?;
        let library = &prepared.run.library;
        let path = match px {
            None => library.original_path(&image_id),
            Some(px) => library.thumbnail(&image_id, px),
        }
        .map_err(|e| e.to_string())?;
        std::fs::read(path)
            .map(Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存报告（JSON 与 Markdown），返回 JSON 的路径。`--exit` 时随后退出。
#[tauri::command]
pub async fn gate_save(
    app: AppHandle,
    state: State<'_, GateState>,
    report: serde_json::Value,
    markdown: String,
    passed: bool,
) -> Result<PathBuf, String> {
    let prepared = state.wait()?;
    let stamp = chrono_stamp();
    let json = prepared
        .report_dir
        .join(format!("fidelity-report-{stamp}.json"));
    let md = json.with_extension("md");
    std::fs::create_dir_all(&prepared.report_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        &json,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(&md, markdown).map_err(|e| e.to_string())?;
    if *state.exit.lock().unwrap_or_else(|e| e.into_inner()) {
        app.exit(if passed { 0 } else { 1 });
    }
    Ok(json)
}
