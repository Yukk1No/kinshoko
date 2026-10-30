//! #367 one-off prototype: pixiv embedded login (WebView2 via wry, the same layer Tauri uses)
//! and read-capability probes. Never prints tokens, cookies or the account's own ids.
//!
//!   pixiv-login-proto login   open the pixiv login window, capture the PKCE code, store the refresh token
//!   pixiv-login-proto probe   use the stored refresh token to probe app-api read capabilities
//!   pixiv-login-proto forget  delete the stored token and the WebView2 profile

use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use md5::{Digest as _, Md5};
use serde_json::Value;
use sha2::Sha256;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{WebContext, WebViewBuilder};

const CLIENT_ID: &str = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET: &str = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET: &str = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";
const REDIRECT_URI: &str = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback";
const AUTH_UA: &str = "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)";
const APP_UA: &str = "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)";
const API: &str = "https://app-api.pixiv.net";

fn state_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA");
    PathBuf::from(base).join("kinshoko-pixiv-proto")
}

fn token_path() -> PathBuf {
    state_dir().join("refresh_token")
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("login") => login(),
        Some("probe") => probe(),
        Some("forget") => {
            let _ = fs::remove_dir_all(state_dir());
            println!("removed {}", state_dir().display());
        }
        _ => eprintln!("usage: pixiv-login-proto login|probe|forget"),
    }
}

/// Strip the query so logs never contain codes or other secrets.
fn redact(url: &str) -> String {
    let q = url.find('?').map(|i| &url[..i]).unwrap_or(url);
    let has_code = url.contains("code=");
    format!("{q}{}", if has_code { "  [has code=]" } else { "" })
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn login() {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).unwrap();
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = format!(
        "https://app-api.pixiv.net/web/v1/login?code_challenge={challenge}&code_challenge_method=S256&client=pixiv-android"
    );

    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Kinshoko 原型：登录 pixiv（#367）")
        .with_inner_size(tao::dpi::LogicalSize::new(480.0, 760.0))
        .build(&event_loop)
        .unwrap();

    fs::create_dir_all(state_dir()).unwrap();
    let mut ctx = WebContext::new(Some(state_dir().join("webview2")));
    let captured = Arc::new(Mutex::new(false));
    let nav_captured = captured.clone();
    let _webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(&url)
        .with_navigation_handler(move |u: String| {
            println!("nav  {}", redact(&u));
            let is_callback = u.starts_with("pixiv://") || u.starts_with(REDIRECT_URI);
            if is_callback {
                if let Some(code) = query_param(&u, "code") {
                    let mut done = nav_captured.lock().unwrap();
                    if !*done {
                        *done = true;
                        let _ = proxy.send_event(code);
                    }
                    return false;
                }
            }
            true
        })
        .with_new_window_req_handler(|u: String, _features| {
            println!("popup {}", redact(&u));
            wry::NewWindowResponse::Allow
        })
        .build(&window)
        .unwrap();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(code) => {
                println!("captured authorization code (len {})", code.len());
                match exchange(&[
                    ("client_id", CLIENT_ID),
                    ("client_secret", CLIENT_SECRET),
                    ("code", &code),
                    ("code_verifier", &verifier),
                    ("grant_type", "authorization_code"),
                    ("include_policy", "true"),
                    ("redirect_uri", REDIRECT_URI),
                ]) {
                    Ok(v) => {
                        let rt = v["refresh_token"].as_str().unwrap_or_default();
                        fs::write(token_path(), rt).unwrap();
                        println!(
                            "OK: refresh token obtained (len {}), stored outside the repo; user.x_restrict = {}",
                            rt.len(),
                            v["user"]["x_restrict"]
                        );
                    }
                    Err(e) => println!("token exchange FAILED: {e}"),
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                println!("window closed by user before a code was captured");
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn client_headers(req: ureq::Request) -> ureq::Request {
    let time = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    let hash = hex(&Md5::digest(format!("{time}{HASH_SECRET}").as_bytes()));
    req.set("X-Client-Time", &time).set("X-Client-Hash", &hash)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// POST /auth/token. Error text carries only the status and pixiv's error field, never the body.
fn exchange(form: &[(&str, &str)]) -> Result<Value, String> {
    let req = client_headers(ureq::post("https://oauth.secure.pixiv.net/auth/token"))
        .set("User-Agent", AUTH_UA)
        .set("App-OS", "android");
    match req.send_form(form) {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let v: Value = r.into_json().unwrap_or_default();
            Err(format!("HTTP {code} {}", v["errors"]["system"]["message"]))
        }
        Err(e) => Err(e.to_string()),
    }
}

struct Api {
    access: String,
}

impl Api {
    fn get(&self, path: &str) -> Result<Value, String> {
        let url = if path.starts_with("http") { path.to_string() } else { format!("{API}{path}") };
        let req = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", self.access))
            .set("User-Agent", APP_UA)
            .set("App-OS", "ios")
            .set("App-OS-Version", "14.6")
            .set("Accept-Language", "ja");
        std::thread::sleep(std::time::Duration::from_millis(1500));
        match req.call() {
            Ok(r) => r.into_json().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn image(url: &str, referer: Option<&str>) -> String {
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let mut req = ureq::get(url);
    if let Some(r) = referer {
        req = req.set("Referer", r);
    }
    match req.call() {
        Ok(r) => {
            let ct = r.content_type().to_string();
            let mut buf = Vec::new();
            r.into_reader().read_to_end(&mut buf).unwrap();
            format!("200 {ct} {} bytes", buf.len())
        }
        Err(ureq::Error::Status(code, _)) => format!("HTTP {code}"),
        Err(e) => e.to_string(),
    }
}

fn illusts(v: &Value) -> Vec<Value> {
    v["illusts"].as_array().cloned().unwrap_or_default()
}

fn summary(label: &str, r: &Result<Value, String>) -> Vec<Value> {
    match r {
        Ok(v) => {
            let list = illusts(v);
            let r18 = list.iter().filter(|i| i["x_restrict"].as_i64().unwrap_or(0) > 0).count();
            let ugoira = list.iter().filter(|i| i["type"] == "ugoira").count();
            let manga = list.iter().filter(|i| i["type"] == "manga").count();
            println!(
                "{label}: OK, {} items on first page (R-18 {r18}, manga {manga}, ugoira {ugoira}), next_url {}",
                list.len(),
                if v["next_url"].is_string() { "yes" } else { "no" }
            );
            list
        }
        Err(e) => {
            println!("{label}: {e}");
            vec![]
        }
    }
}

fn original_urls(i: &Value) -> Vec<String> {
    let pages = i["meta_pages"].as_array().cloned().unwrap_or_default();
    if pages.is_empty() {
        i["meta_single_page"]["original_image_url"].as_str().map(String::from).into_iter().collect()
    } else {
        pages.iter().filter_map(|p| p["image_urls"]["original"].as_str().map(String::from)).collect()
    }
}

fn probe() {
    let rt = fs::read_to_string(token_path()).expect("no stored token; run `login` first");
    let tok = match exchange(&[
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("grant_type", "refresh_token"),
        ("include_policy", "true"),
        ("refresh_token", rt.trim()),
    ]) {
        Ok(v) => v,
        Err(e) => return println!("refresh FAILED: {e}"),
    };
    println!(
        "refresh: OK, access token expires_in {}s, refresh token rotated: {}, user.x_restrict = {}",
        tok["expires_in"],
        tok["refresh_token"].as_str() != Some(rt.trim()),
        tok["user"]["x_restrict"]
    );
    if let Some(new_rt) = tok["refresh_token"].as_str() {
        fs::write(token_path(), new_rt).unwrap();
    }
    let me = tok["user"]["id"].as_str().unwrap_or_default().to_string();
    let api = Api { access: tok["access_token"].as_str().unwrap_or_default().to_string() };

    // Following list (public and private).
    let mut artist = None;
    for restrict in ["public", "private"] {
        match api.get(&format!("/v1/user/following?user_id={me}&restrict={restrict}")) {
            Ok(v) => {
                let n = v["user_previews"].as_array().map(|a| a.len()).unwrap_or(0);
                println!(
                    "following ({restrict}): OK, {n} users on first page, next_url {}",
                    if v["next_url"].is_string() { "yes" } else { "no" }
                );
                if artist.is_none() {
                    artist = v["user_previews"][0]["user"]["id"].as_i64();
                }
            }
            Err(e) => println!("following ({restrict}): {e}"),
        }
    }

    // Bookmarks.
    for restrict in ["public", "private"] {
        summary(
            &format!("bookmarks ({restrict})"),
            &api.get(&format!("/v1/user/bookmarks/illust?user_id={me}&restrict={restrict}")),
        );
    }

    // Rankings.
    let mut r18_sample = None;
    for mode in ["day", "week", "month", "day_r18", "week_r18"] {
        let list = summary(&format!("ranking {mode}"), &api.get(&format!("/v1/illust/ranking?mode={mode}")));
        if mode == "day_r18" {
            r18_sample = list.into_iter().find(|i| i["type"] == "illust");
        }
    }

    // An artist's works: first a followed artist, else the top of today's ranking.
    let artist = artist.or_else(|| {
        api.get("/v1/illust/ranking?mode=day").ok().and_then(|v| v["illusts"][0]["user"]["id"].as_i64())
    });
    if let Some(a) = artist {
        let list = summary("artist works (type=illust)", &api.get(&format!("/v1/user/illusts?user_id={a}&type=illust")));
        summary("artist works (type=manga)", &api.get(&format!("/v1/user/illusts?user_id={a}&type=manga")));
        if let Some(multi) = list.iter().find(|i| i["page_count"].as_i64().unwrap_or(1) > 1).or(list.first()) {
            let id = multi["id"].as_i64().unwrap_or_default();
            match api.get(&format!("/v1/illust/detail?illust_id={id}")) {
                Ok(d) => {
                    let urls = original_urls(&d["illust"]);
                    println!("illust detail: OK, page_count {}, {} original urls", d["illust"]["page_count"], urls.len());
                    if let Some(last) = urls.last() {
                        println!("  original (last page), no referer:  {}", image(last, None));
                        println!("  original (last page), app referer: {}", image(last, Some("https://app-api.pixiv.net/")));
                    }
                }
                Err(e) => println!("illust detail: {e}"),
            }
        }
    }

    // R-18: detail + original via token, then the same id anonymously through the web ajax.
    if let Some(i) = r18_sample {
        let id = i["id"].as_i64().unwrap_or_default();
        let user = i["user"]["id"].as_i64().unwrap_or_default();
        match api.get(&format!("/v1/illust/detail?illust_id={id}")) {
            Ok(d) => {
                let urls = original_urls(&d["illust"]);
                println!("R-18 illust detail: OK, x_restrict {}, {} original urls", d["illust"]["x_restrict"], urls.len());
                if let Some(u) = urls.first() {
                    println!("  R-18 original, app referer: {}", image(u, Some("https://app-api.pixiv.net/")));
                }
            }
            Err(e) => println!("R-18 illust detail: {e}"),
        }
        let anon = |path: String| -> String {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            match ureq::get(&format!("https://www.pixiv.net{path}"))
                .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
                .set("Referer", "https://www.pixiv.net/")
                .call()
            {
                Ok(r) => {
                    let v: Value = r.into_json().unwrap_or_default();
                    if v["error"] == true {
                        format!("200 but error: {}", v["message"])
                    } else {
                        let b = &v["body"];
                        format!(
                            "200 ok (illusts {}, xRestrict {}, original url present {})",
                            b["illusts"].as_object().map(|o| o.len().to_string()).unwrap_or("-".into()),
                            b["xRestrict"],
                            b["urls"]["original"].is_string()
                        )
                    }
                }
                Err(ureq::Error::Status(c, _)) => format!("HTTP {c}"),
                Err(e) => e.to_string(),
            }
        };
        println!("anon ajax illust (R-18 id):        {}", anon(format!("/ajax/illust/{id}")));
        println!("anon ajax profile/all (its artist): {}", anon(format!("/ajax/user/{user}/profile/all")));
        summary("token user/illusts (same artist)", &api.get(&format!("/v1/user/illusts?user_id={user}&type=illust")));
    } else {
        println!("no R-18 sample available (R-18 ranking not readable)");
    }
}
