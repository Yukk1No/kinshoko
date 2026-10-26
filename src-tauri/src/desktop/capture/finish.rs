//! 框选完成：在可见性提交门内再核对一次冻结的来源，解码、写截图历史，再钉住或复制。

use std::time::Duration;
#[cfg(debug_assertions)]
use std::time::Instant;

use kinshoko_core::desktop::{CaptureAction, CaptureOutcome, CaptureSelection, Region, ScreenRect};
use kinshoko_core::diagnostics::LogEvent;
use kinshoko_core::reference_groups::ReferenceSource;
use tauri::{AppHandle, Manager};

use super::{CloseOnDrop, Pending, Session};
use crate::desktop::{clipboard::PreparedImage, history_changed, lock, pins, state};

/// Recheck the frozen source after decoding, while the final visibility permit is held.
/// The frozen geometry remains authoritative; later scrolling does not change its crop.
fn validate_source(app: &AppHandle, pending: &Pending, selected: ScreenRect) -> Result<(), String> {
    let mut candidates = pending
        .references
        .iter()
        .filter(|surface| surface.selection.reference_region(selected).is_some());
    let surface = match (candidates.next(), candidates.next()) {
        (Some(surface), None) => surface,
        _ => return Ok(()), // Ordinary screen selection, as in CaptureSelection::finish.
    };
    let kinshoko_core::desktop::PinContent::Reference {
        library_id,
        image_id,
        source_width,
        source_height,
    } = &surface.selection.pin.content
    else {
        return Err("参考图来源已变化，请重新框选".into());
    };
    if surface.window == "main" {
        // Includes the strictest rating of every known byte-identical provider.
        crate::library::visible_source(app, library_id, image_id)?;
    } else if !pins::capture_source_open(app, &surface.selection.pin.id)
        || (surface.hwnd.is_none() && app.get_webview_window(&surface.window).is_none())
    {
        return Err("参考图已关闭，请重新框选".into());
    }
    let image = crate::library::with_references(app, |sources| sources.image(library_id, image_id))
        .map_err(|error| error.to_string())?;
    if image.width != *source_width || image.height != *source_height {
        return Err("参考图来源已变化，请重新框选".into());
    }
    let safe = crate::library::safe_mode_on(app);
    let mut veils = lock(&state(app).veils).clone();
    // This function also runs before decoding, outside the commit gate. Adjust only
    // this local view; committed veil mutations are serialized by visibility authority.
    veils.set_safe_mode(safe);
    veils.set_scope(crate::library::safe_mode_scope(app));
    if veils.veiled(&surface.selection.pin, Some(image.sealed)) {
        return Err("参考图已被遮蔽，请重新框选".into());
    }
    Ok(())
}

/// 框选完成。`region` 是相对显示器的物理像素。
#[tauri::command]
pub async fn finish_capture(
    app: AppHandle,
    region: Region,
    action: CaptureAction,
    token: String,
) -> Result<(), String> {
    crate::desktop::timing("finish.begin");
    let pending = {
        let mut session = lock(&state(&app).capture);
        match std::mem::replace(&mut *session, Session::Grabbing(token.clone())) {
            Session::Ready(p) if p.token == token => p,
            other => {
                *session = other;
                return Err("没有进行中的截图".to_owned());
            }
        }
    };
    // 框选窗口留到结果可用（剪贴板写好／钉图已显示）才隐藏，期间页面显示进度（#127）：
    // 读大原图可能要一秒左右，先关掉窗口会让人以为按键没生效。
    tauri::async_runtime::spawn_blocking(move || {
        // 出错甚至 panic 也要结束会话、隐藏窗口，否则之后的 F1 都被当成还在截。
        let close = CloseOnDrop(&app, &token);
        let started = std::time::Instant::now();
        let result = finish_blocking(&app, pending, region, action);
        if let Ok(Some(pin)) = &result {
            pins::wait_shown(&app, pin, Duration::from_secs(5));
            // 框选窗口关掉时系统把激活交还给原来的窗口；它若是置顶窗口就会盖住新钉图。
            // 隐藏与交还激活都是异步的：等它们做完再放上来。
            drop(close);
            std::thread::sleep(Duration::from_millis(150));
            pins::raise_native(&app, pin);
        }
        match &result {
            Ok(_) => crate::run_log::record(LogEvent::CaptureFinished {
                ms: crate::run_log::ms_since(started),
            }),
            Err(e) => crate::run_log::warn("截图收尾失败", e),
        }
        result.map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 完成一次框选：解码、提交并产生结果。钉住时返回新钉图的 id。
fn finish_blocking(
    app: &AppHandle,
    pending: Pending,
    region: Region,
    action: CaptureAction,
) -> Result<Option<String>, String> {
    let references: Vec<_> = pending
        .references
        .iter()
        .map(|s| s.selection.clone())
        .collect();
    let selection = CaptureSelection {
        screen: &pending.screen,
        origin: pending.origin,
        region,
        references: &references,
    };
    let at = selection.screen_rect().map_err(|e| e.to_string())?;
    if crate::library::capture_generation(app) != pending.safe_generation {
        return Err("安全模式已变化，请重新框选".into());
    }
    validate_source(app, &pending, at)?;
    // Only the final validation grants authority. Do not keep the veil mutex through
    // original decoding: a mode commit must be able to revoke while this work runs.
    let veils = lock(&state(app).veils).clone();
    #[cfg(debug_assertions)]
    let prepare_started = Instant::now();
    #[cfg(debug_assertions)]
    eprintln!("capture.source.prepare.begin at={}", now_ms());
    let draft = crate::library::with_references(app, |sources| {
        selection.prepare(
            action,
            &uuid::Uuid::new_v4().simple().to_string(),
            sources,
            &veils,
        )
    })
    .map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    eprintln!(
        "capture.source.prepare.end at={} ms={}",
        now_ms(),
        prepare_started.elapsed().as_millis()
    );
    // PNG compression and DIBV5 conversion finish before taking visibility authority.
    // Revocation can return while these expensive, discardable preparations are running.
    let clipboard = draft
        .clipboard_image()
        .map(PreparedImage::prepare)
        .transpose()?;
    crate::desktop::timing("finish.prepared");
    // Mode/settings, source edits, providers and automatic ratings share this commit gate.
    // Only history persistence and the actual OS/pin side effect occur within it.
    let committed = crate::library::with_visibility_commit(app, |generation| {
        if generation != pending.safe_generation {
            return Err("安全模式已变化，请重新框选".into());
        }
        validate_source(app, &pending, at)?;
        let outcome = draft
            .commit_with_history(|prepared| lock(&state(app).history).add_prepared(prepared))
            .map_err(|error| error.to_string())?;
        history_changed(app);
        match outcome {
            CaptureOutcome::PinReference(pin) => {
                pins::open_reference_selection(app, pin, at).map(Some)
            }
            CaptureOutcome::CopyReference(_) => clipboard
                .expect("copy draft prepared clipboard formats")
                .commit(app)
                .map(|()| None),
            CaptureOutcome::PinCapture(entry) => pins::open(
                app,
                &entry,
                ScreenRect {
                    width: entry.width,
                    height: entry.height,
                    ..at
                },
            )
            .map(Some),
            CaptureOutcome::CopyCapture(_) => clipboard
                .expect("copy draft prepared clipboard formats")
                .commit(app)
                .map(|()| None),
        }
    });
    crate::desktop::timing(&format!("finish.end ok={}", committed.is_ok()));
    committed
}

#[cfg(debug_assertions)]
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
