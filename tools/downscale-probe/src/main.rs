//! Kinshoko 缩小对比（#48）：双击运行，在 WebView2 窗口里逐组并排比较两种缩小算法，
//! 报告 zip 保存到桌面。
//!
//! 参数（开发与 CI 用）：
//! - `--self-test [目录]`：不开窗口，用构造样本生成全部分组、写一份报告并读回检查，
//!   结果写到目录下的 `self-test.txt`，失败时退出码非 0；
//! - `--samples-dir <目录>`：从本机文件夹取公开样本（pixiv 文件名，按清单哈希校验），不下载；
//! - `--no-download`：只用构造样本；
//! - `--dump <目录>`：把构造样本与两种缩略图写成文件，供开发者查看。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kinshoko_downscale_probe::report::{self, Answer};
use kinshoko_downscale_probe::samples::{self, Sample};
use kinshoko_downscale_probe::{Algorithm, Plan};
use serde::Deserialize;
use serde_json::{Value, json};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{Request, Response, StatusCode, header};
use wry::{WebContext, WebViewBuilder};

const PAGE: &str = include_str!("page.html");

#[derive(Default)]
struct Args {
    self_test: Option<PathBuf>,
    samples_dir: Option<PathBuf>,
    no_download: bool,
    dump: Option<PathBuf>,
}

fn args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1).peekable();
    while let Some(arg) = it.next() {
        let mut value = || it.next_if(|v| !v.starts_with("--")).map(PathBuf::from);
        match arg.as_str() {
            "--self-test" => {
                a.self_test = Some(value().unwrap_or_else(|| {
                    std::env::temp_dir().join("kinshoko-downscale-probe-self-test")
                }))
            }
            "--samples-dir" => a.samples_dir = value(),
            "--no-download" => a.no_download = true,
            "--dump" => a.dump = value(),
            _ => {}
        }
    }
    a
}

/// 本机数据目录：公开样本缓存与 WebView2 的用户数据。
fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Kinshoko")
        .join("downscale-probe")
}

fn desktop() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    [
        home.join("Desktop"),
        home.join("OneDrive").join("Desktop"),
        home.join("OneDrive").join("桌面"),
    ]
    .into_iter()
    .find(|p| p.is_dir())
}

fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(48)
}

fn main() {
    let args = args();
    if let Some(dir) = &args.self_test {
        let result = self_test(dir);
        let text = match &result {
            Ok(summary) => format!("通过\n{summary}\n"),
            Err(e) => format!("失败：{e}\n"),
        };
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("self-test.txt"), &text);
        print!("{text}");
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    if let Some(dir) = &args.dump {
        if let Err(e) = dump(dir) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    run_window(args);
}

/// CI 自测：构造样本 → 全部分组 → 报告 zip → 读回。
fn self_test(dir: &Path) -> Result<String, String> {
    let samples = samples::constructed();
    let plan = Plan::prepare(&samples, 48, |_, _| {})?;
    if plan.groups.len() != samples.len() * kinshoko_downscale_probe::SCALES.len() {
        return Err("分组数不对".into());
    }
    let answers: Vec<Answer> = plan
        .groups
        .iter()
        .map(|g| Answer {
            group: g.number,
            choice: Some(report::Choice::Left),
            comment: String::new(),
            seconds: 1.0,
        })
        .collect();
    let env = json!({ "selfTest": true, "webview2": wry::webview_version().ok() });
    let path =
        report::write_report(dir, &plan, &answers, "自测", env).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let json: Value =
        serde_json::from_reader(zip.by_name("report.json").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let tally = &json["tally"];
    let chosen = tally[Algorithm::LinearLight.key()].as_u64().unwrap_or(0)
        + tally[Algorithm::EncodedValue.key()].as_u64().unwrap_or(0);
    if chosen as usize != plan.groups.len() {
        return Err(format!("报告的计数不对：{tally}"));
    }
    Ok(format!(
        "{} 个构造样本，{} 组；WebView2 {}",
        samples.len(),
        plan.groups.len(),
        json["environment"]["webview2"].as_str().unwrap_or("未安装")
    ))
}

fn dump(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let samples = samples::constructed();
    let plan = Plan::prepare(&samples, 48, |_, _| {})?;
    for s in &samples {
        std::fs::write(dir.join(format!("{}.png", s.id)), &s.bytes).map_err(|e| e.to_string())?;
    }
    for g in &plan.groups {
        for (a, img) in [(g.left, &g.left_image), (g.right, &g.right_image)] {
            let ext = if img.mime == "image/png" {
                "png"
            } else {
                "webp"
            };
            let name = format!(
                "{}-{}-{}.{ext}",
                g.sample_id,
                g.scale.replace('/', "_"),
                a.key()
            );
            std::fs::write(dir.join(name), &img.bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 窗口

enum UserEvent {
    /// 在页面里执行一段脚本。
    Eval(String),
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Message {
    Start,
    Save {
        answers: Vec<Answer>,
        comment: String,
        environment: Value,
    },
    ShowReport,
}

#[derive(Default)]
struct Shared {
    plan: Mutex<Option<Plan>>,
    saved: Mutex<Option<PathBuf>>,
}

fn call(proxy: &EventLoopProxy<UserEvent>, function: &str, arg: Value) {
    let _ = proxy.send_event(UserEvent::Eval(format!("window.probe.{function}({arg})")));
}

fn prepare(args: &Args, proxy: &EventLoopProxy<UserEvent>) -> Result<Plan, String> {
    call(proxy, "progress", json!({ "text": "正在生成构造的线稿…" }));
    let mut all: Vec<Sample> = samples::constructed();
    let mut missing = Vec::new();
    if let Some(dir) = &args.samples_dir {
        all.extend(samples::public_from_dir(dir));
    } else if !args.no_download {
        let (public, failed) = samples::fetch_public(&data_dir().join("samples"), |done, total| {
            call(
                proxy,
                "progress",
                json!({ "text": format!("正在下载公开样本（{done}/{total}），第一次运行需要几分钟…") }),
            )
        });
        all.extend(public);
        missing = failed;
    }
    let plan = Plan::prepare(&all, seed(), |done, total| {
        call(
            proxy,
            "progress",
            json!({ "text": format!("正在生成缩略图（{done}/{total} 组）…") }),
        )
    })?;
    if !missing.is_empty() {
        call(
            proxy,
            "notice",
            json!(format!(
                "有 {} 个公开样本没有下载成功（网络问题），这次只比较其余的样本。",
                missing.len()
            )),
        );
    }
    Ok(plan)
}

fn groups_for_page(plan: &Plan) -> Value {
    // 只告诉页面组号、说明与比例；哪一边是哪种算法不进页面。
    json!(
        plan.groups
            .iter()
            .map(|g| json!({
                "number": g.number,
                "description": g.description,
                "public": g.sample_kind == samples::SampleKind::Public,
                "scale": g.scale,
                "width": g.left_image.width,
                "height": g.left_image.height,
            }))
            .collect::<Vec<_>>()
    )
}

fn respond(
    status: StatusCode,
    mime: &str,
    body: Cow<'static, [u8]>,
) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("响应可构造")
}

fn serve(shared: &Shared, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/').to_string();
    if path.is_empty() || path == "index.html" {
        return respond(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Cow::Borrowed(PAGE.as_bytes()),
        );
    }
    let parts: Vec<&str> = path.split('/').collect();
    let plan = shared.plan.lock().expect("锁未中毒");
    let group = parts
        .get(1)
        .and_then(|n| n.parse::<usize>().ok())
        .and_then(|n| plan.as_ref()?.groups.iter().find(|g| g.number == n));
    let Some(group) = group else {
        return respond(
            StatusCode::NOT_FOUND,
            "text/plain",
            Cow::Borrowed(b"not found"),
        );
    };
    match (parts[0], parts.get(2).copied()) {
        ("img", Some("left")) => respond(
            StatusCode::OK,
            group.left_image.mime,
            Cow::Owned(group.left_image.bytes.clone()),
        ),
        ("img", Some("right")) => respond(
            StatusCode::OK,
            group.right_image.mime,
            Cow::Owned(group.right_image.bytes.clone()),
        ),
        ("orig", _) => {
            let mime = match image::guess_format(&group.original) {
                Ok(image::ImageFormat::Png) => "image/png",
                Ok(image::ImageFormat::Jpeg) => "image/jpeg",
                Ok(image::ImageFormat::WebP) => "image/webp",
                Ok(image::ImageFormat::Gif) => "image/gif",
                _ => "application/octet-stream",
            };
            respond(
                StatusCode::OK,
                mime,
                Cow::Owned(group.original.as_ref().clone()),
            )
        }
        _ => respond(
            StatusCode::NOT_FOUND,
            "text/plain",
            Cow::Borrowed(b"not found"),
        ),
    }
}

fn handle(
    message: Message,
    args: &Arc<Args>,
    shared: &Arc<Shared>,
    proxy: &EventLoopProxy<UserEvent>,
) {
    match message {
        Message::Start => {
            let (args, shared, proxy) = (args.clone(), shared.clone(), proxy.clone());
            std::thread::spawn(move || match prepare(&args, &proxy) {
                Ok(plan) => {
                    let groups = groups_for_page(&plan);
                    *shared.plan.lock().expect("锁未中毒") = Some(plan);
                    call(&proxy, "ready", groups);
                }
                Err(e) => call(&proxy, "failed", json!(format!("准备样本失败：{e}"))),
            });
        }
        Message::Save {
            answers,
            comment,
            mut environment,
        } => {
            environment["webview2"] = json!(wry::webview_version().ok());
            let plan = shared.plan.lock().expect("锁未中毒");
            let Some(plan) = plan.as_ref() else { return };
            let dir = desktop().unwrap_or_else(data_dir);
            match report::write_report(&dir, plan, &answers, &comment, environment) {
                Ok(path) => {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let place = if desktop().is_some() {
                        "桌面"
                    } else {
                        "程序的数据文件夹"
                    };
                    *shared.saved.lock().expect("锁未中毒") = Some(path);
                    call(proxy, "saved", json!({ "name": name, "place": place }));
                }
                Err(e) => call(proxy, "failed", json!(format!("保存报告失败：{e}"))),
            }
        }
        Message::ShowReport => {
            if let Some(path) = shared.saved.lock().expect("锁未中毒").as_ref() {
                let _ = std::process::Command::new("explorer")
                    .arg(format!("/select,{}", path.display()))
                    .spawn();
            }
        }
    }
}

fn run_window(args: Args) {
    let args = Arc::new(args);
    let shared = Arc::new(Shared::default());
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Kinshoko 缩小对比")
        .with_maximized(true)
        .build(&event_loop)
        .expect("无法创建窗口");

    let mut context = WebContext::new(Some(data_dir().join("webview")));
    let serve_state = shared.clone();
    let ipc_proxy = proxy.clone();
    let ipc_args = args.clone();
    let ipc_shared = shared.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_custom_protocol("probe".into(), move |_id, request| {
            serve(&serve_state, request)
        })
        .with_ipc_handler(move |request: Request<String>| {
            match serde_json::from_str::<Message>(request.body()) {
                Ok(message) => handle(message, &ipc_args, &ipc_shared, &ipc_proxy),
                Err(e) => call(&ipc_proxy, "failed", json!(format!("内部错误：{e}"))),
            }
        })
        .with_url("probe://localhost/")
        .build(&window);
    let webview = match webview {
        Ok(w) => w,
        Err(e) => {
            // 没有 WebView2 运行时等情况：用系统消息框说明（不依赖窗口）。
            let _ = std::process::Command::new("mshta")
                .arg(format!(
                    "javascript:alert('无法打开窗口：{}');close()",
                    e.to_string().replace('\'', " ")
                ))
                .status();
            return;
        }
    };

    event_loop.run(move |event, _, control_flow| {
        // WebView2 的用户数据目录要活得和窗口一样久。
        let _ = &context;
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
