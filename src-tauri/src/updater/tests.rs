//! 安装失败后的重试：用模拟运行时加真实的 updater 插件，向本机的更新入口下载，下载中途断开。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

use super::*;

/// 本机的更新入口：`latest.json` 指向同一入口的安装包，安装包每次都只发一部分就断开。
struct Endpoint {
    url: String,
    downloads: Arc<AtomicUsize>,
}

impl Endpoint {
    /// `on_download` 在每次开始下载、断开之前调用。每个请求单独一个线程，下载途中也能再请求。
    fn start(on_download: impl Fn() + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let downloads = Arc::new(AtomicUsize::new(0));
        let (base, count) = (url.clone(), downloads.clone());
        let on_download = Arc::new(on_download);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let (base, count, on_download) = (base.clone(), count.clone(), on_download.clone());
                std::thread::spawn(move || match request_path(&stream).as_str() {
                    "/latest.json" => respond(&mut stream, &latest(&base)),
                    _ => {
                        count.fetch_add(1, Ordering::SeqCst);
                        on_download();
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\n\r\npartial",
                        );
                    }
                });
            }
        });
        Endpoint { url, downloads }
    }

    fn downloads(&self) -> usize {
        self.downloads.load(Ordering::SeqCst)
    }
}

fn request_path(stream: &TcpStream) -> String {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let path = line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    while reader.read_line(&mut line).unwrap() > 2 {
        line.clear();
    }
    path
}

fn respond(stream: &mut TcpStream, body: &str) {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body.as_bytes()).unwrap();
}

fn latest(base: &str) -> String {
    serde_json::json!({
        "version": "9.9.9",
        "platforms": { "test": { "url": format!("{base}/kinshoko-setup.exe"), "signature": "unused" } },
    })
    .to_string()
}

/// 公开阶段的构建，配置与发布用的 `tauri.conf.json` 相同；实际请求的入口由测试指定。
fn app() -> AppHandle<MockRuntime> {
    let mut context = mock_context(noop_assets());
    let release: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let mut updater = release["plugins"]["updater"].clone();
    updater["dangerousInsecureTransportProtocol"] = true.into();
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), updater);
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let handle = app.handle().clone();
    handle.manage(UpdaterState::new(&handle));
    handle
}

/// 像 [`check_update`] 查到新版本那样，留下可安装的更新。
fn check(app: &AppHandle<MockRuntime>, endpoint: &Endpoint) {
    let url = Url::parse(&format!("{}/latest.json", endpoint.url)).unwrap();
    let update = tauri::async_runtime::block_on(async {
        app.updater_builder()
            .endpoints(vec![url])
            .unwrap()
            .target("test")
            .build()
            .unwrap()
            .check()
            .await
    })
    .unwrap()
    .expect("本机入口提供新版本");
    let state = app.state::<UpdaterState>();
    state.set(UpdateStatus::Available {
        version: update.version.clone(),
        notes: None,
    });
    *lock(&state.pending) = Some(update);
}

fn install(app: &AppHandle<MockRuntime>) -> ErrorKind {
    tauri::async_runtime::block_on(install_pending(app, &app.state::<UpdaterState>()))
        .expect_err("下载中途断开，安装不会成功")
        .kind
}

#[test]
fn retrying_after_an_interrupted_download_downloads_again() {
    let endpoint = Endpoint::start(|| {});
    let app = app();
    check(&app, &endpoint);

    assert_eq!(install(&app), ErrorKind::UpdateInstallFailed);
    assert_eq!(install(&app), ErrorKind::UpdateInstallFailed);
    assert_eq!(endpoint.downloads(), 2, "重试又下载了一次");
    assert!(matches!(
        app.state::<UpdaterState>().status(),
        UpdateStatus::Available { .. }
    ));
}

#[test]
fn a_channel_change_during_the_download_drops_the_update() {
    let app = app();
    let changer = app.clone();
    let endpoint = Endpoint::start(move || channel_changed(&changer));
    check(&app, &endpoint);

    assert_eq!(install(&app), ErrorKind::UpdateInstallFailed);
    assert_eq!(install(&app), ErrorKind::UpdateNotPending);
    assert_eq!(endpoint.downloads(), 1);
    assert_eq!(
        app.state::<UpdaterState>().status(),
        UpdateStatus::Unchecked
    );
}

#[test]
fn a_second_install_during_the_download_is_refused() {
    let app = app();
    let during = Arc::new(Mutex::new(None));
    let (installer, seen, first) = (app.clone(), during.clone(), AtomicBool::new(true));
    let endpoint = Endpoint::start(move || {
        if first.swap(false, Ordering::SeqCst) {
            *seen.lock().unwrap() = Some(install(&installer));
        }
    });
    check(&app, &endpoint);

    assert_eq!(install(&app), ErrorKind::UpdateInstallFailed);
    assert_eq!(*during.lock().unwrap(), Some(ErrorKind::UpdateInstalling));
    assert_eq!(endpoint.downloads(), 1, "下载途中的第二次安装没有再下载");
    assert_eq!(install(&app), ErrorKind::UpdateInstallFailed);
    assert_eq!(endpoint.downloads(), 2, "失败后可以重试");
}
