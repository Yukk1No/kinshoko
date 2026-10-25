//! 查找、安全模式、近似对应与外部词表的命令。

use super::*;

/// 搜索框打字时的分级候选（#161），与资料库无关。`safe_mode` 是界面当前的视角；应用的安全
/// 模式设置开着时也按开着处理，切换的这一刻不会露出范围内的分级候选。“R18”与要隐藏的分级
/// 按设置里的安全模式范围（#223）。
#[tauri::command]
pub(super) fn rating_candidates(
    state: State<'_, LibraryState>,
    text: String,
    safe_mode: bool,
) -> Vec<RatingCandidate> {
    kinshoko_core::search::rating_candidates(&text, state.safe_mode.effective(safe_mode))
}

/// 搜索框打字时的候选：按命名空间与别名列出，名称按界面语言 `lang`。`safe_mode` 是界面
/// 当前的视角；资料库的安全模式不同（刚切换）时返回错误，候选不会落到另一视角上（#76）。
#[tauri::command]
pub(super) async fn search_candidates<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    text: String,
    lang: String,
    limit: u32,
    safe_mode: bool,
) -> Result<Vec<Candidate>, String> {
    let catalog = state.catalog.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        let search = catalog
            .search(&library, safe_mode)
            .map_err(|e| e.to_string())?;
        Ok(search.candidates(&text, &lang, limit as usize))
    })
    .await
}

/// 把搜索框里的条件解析成可见的条件树，交给 `browse` 执行。`safe_mode` 同
/// [`search_candidates`]。
#[tauri::command]
pub(super) async fn resolve_search<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    input: SearchInput,
    lang: String,
    safe_mode: bool,
) -> Result<ConditionTree, String> {
    let catalog = state.catalog.clone();
    crate::run_log::record(LogEvent::SearchResolved {
        terms: input.conditions.len().min(u32::MAX as usize) as u32,
    });
    blocking(move || {
        let library = readable(&app, &library_id)?;
        let search = catalog
            .search(&library, safe_mode)
            .map_err(|e| e.to_string())?;
        Ok(search.resolve(&input, &lang))
    })
    .await
}

/// 安全模式是否开启（全局设置）。
#[tauri::command]
pub(super) async fn safe_mode(state: State<'_, LibraryState>) -> Result<bool, String> {
    Ok(state.safe_mode.current().on)
}

/// 开关安全模式：先提交给 [`SafeModeState`] 并保存设置（保存不成时退回原值），再设给开着的
/// 可写资料库；资料库推送 `safeModeChanged`。
/// 安全模式属于本设备，不随资料库变；之后切换到的资料库按保存的设置打开。
#[tauri::command]
pub(super) async fn set_safe_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    on: bool,
) -> Result<bool, String> {
    // 分段耗时（#183）：开发构建在控制台输出等锁、写设置、切换资料库各用了多久。
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    #[cfg(debug_assertions)]
    let saved_at;
    {
        let _visibility = lock(&state.visibility_commit);
        #[cfg(debug_assertions)]
        let locked_at = started.elapsed();
        // Revoke even a repeated setting or failed save; pending work must revalidate.
        state.safe_mode.try_commit(
            |mode| mode.on = on,
            |_| {
                import_preview::revoke(&app);
                let Some(shell) = app.try_state::<ShellState>() else {
                    return Ok(());
                };
                let mut shell = shell.0.lock().map_err(|e| e.to_string())?;
                shell.settings.set_safe_mode(on).map_err(|e| e.to_string())
            },
        )?;
        #[cfg(debug_assertions)]
        {
            saved_at = started.elapsed();
            eprintln!(
                "safe_mode.set on={on} lock_ms={:.1} save_ms={:.1}",
                locked_at.as_secs_f64() * 1e3,
                (saved_at - locked_at).as_secs_f64() * 1e3
            );
        }
        // 可写库与导入仍持有的库都跟着设置（ADR-0008：可写句柄会按需切换）。
        if let Some(libraries) = lock(&state.libraries).as_ref() {
            libraries.set_safe_mode(on);
        }
        // Do not let delayed/reordered event workers preserve a reveal across off -> on.
        crate::desktop::safe_mode_committed(&app, on);
    }
    let _ = app.emit(SAFE_MODE_EVENT, on);
    #[cfg(debug_assertions)]
    eprintln!(
        "safe_mode.set on={on} switch_ms={:.1} total_ms={:.1}",
        (started.elapsed() - saved_at).as_secs_f64() * 1e3,
        started.elapsed().as_secs_f64() * 1e3
    );
    Ok(on)
}

/// 调整安全模式范围（#223）：与开关安全模式同一条路——先保存设置，再设给开着的可写资料库
/// （它们的修订号前进并推送列表与词表变化），钉图随即按新范围重新核对，收紧时清空确认显示；
/// 之后推送 `safe-mode-setting`（开关不变）与新的工作区状态：工作区修订号随范围变化，界面
/// 重读浏览、查找与计数，正在查看的图回到图片墙。返回新的设置。
/// 安全模式关闭时也照此处理（只改变“R18”的含义）。
#[tauri::command]
pub(super) async fn set_safe_mode_scope<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    scope: SafeModeScope,
) -> Result<kinshoko_core::ShellSettingsView, String> {
    let view = {
        let _visibility = lock(&state.visibility_commit);
        // 与开关相同：进行中的读取与发送都要按新视角重新核对；保存不成时退回原值。
        let view = state.safe_mode.try_commit(
            |mode| mode.scope = scope,
            |_| {
                import_preview::revoke(&app);
                let shell = app.state::<ShellState>();
                let mut shell = shell.0.lock().map_err(|e| e.to_string())?;
                shell
                    .settings
                    .set_safe_mode_scope(scope)
                    .map_err(|e| e.to_string())?;
                Ok::<_, String>(shell.view())
            },
        )?;
        state.detached.set_safe_mode_scope(scope);
        if let Some(libraries) = lock(&state.libraries).as_mut()
            && let Err(error) = libraries.set_safe_mode_scope(scope)
        {
            // 视角已换上；只是修订号没写成，游标与工作区快照仍按视角作废。
            crate::run_log::warn("安全模式范围的修订号未写入", error);
        }
        state.catalog.invalidate();
        crate::desktop::safe_mode_scope_committed(&app, scope);
        view
    };
    let safe = state.safe_mode.current().on;
    // 与开关同一个通知：钉图重新核对，跟着安全模式重读的界面（词表、分组、导入……）都重读。
    let _ = app.emit(SAFE_MODE_EVENT, safe);
    if let Ok(status) = workspace::action(&app, safe, |w, d, c| w.status(d, c, safe)) {
        let _ = app.emit(workspace::EVENT, status);
    }
    Ok(view)
}

/// 在个人近似对应表中记下两个标签相近或不相近（“＋”与“以后都不展开”）。
#[tauri::command]
pub(super) async fn set_tag_approx<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    a: String,
    b: String,
    relation: ApproxRelation,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library
            .set_tag_approx(&a, &b, relation)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 删除个人近似对应表中的一对。
#[tauri::command]
pub(super) async fn remove_tag_approx<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    a: String,
    b: String,
) -> Result<(), String> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        library.remove_tag_approx(&a, &b).map_err(|e| e.to_string())
    })
    .await
}

/// 资料库设置中列出的个人近似对应表条目，名称按界面语言 `lang`。
#[tauri::command]
pub(super) async fn personal_approx<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LibraryState>,
    library_id: String,
    lang: String,
) -> Result<Vec<PersonalApproxEntry>, String> {
    let catalog = state.catalog.clone();
    blocking(move || {
        let library = readable(&app, &library_id)?;
        with_catalog(&catalog, |catalog| {
            let snapshot = catalog.synchronize(&library)?;
            let mut entries = library.personal_approx(&lang)?;
            for entry in &mut entries {
                entry.a = snapshot.display_label(&library.info().id, &entry.a, &lang);
                entry.b = snapshot.display_label(&library.info().id, &entry.b, &lang);
            }
            Ok(entries)
        })
    })
    .await
}

/// 随软件分发的翻译表（`data/builtin-translation-table.json`），启动时取一次。唯一的注入点：
/// 每个打开的资料库在装配时（[`forward_events`]）装上它，迁入向导的外部词表也按它匹配。
pub(super) fn bundled_translations() -> TagTranslations {
    TagTranslations::bundled()
}

/// 迁入向导的外部词表：内置近似对应表中的名称、本机已就绪模型的词表与翻译表。
/// 会读文件，不要在主线程上调用。
pub(super) fn external_vocabulary<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ExternalVocabulary, String> {
    let state = app.state::<LibraryState>();
    let csv = crate::tagging::vocabulary_csv(app);
    let mut cached = lock(&state.external_vocabulary);
    if let Some((path, vocabulary)) = cached.as_ref()
        && *path == csv
    {
        return Ok(vocabulary.clone());
    }
    let mut names = ExternalVocabulary::builtin_names(state.catalog.builtin_approx());
    if let Some(path) = &csv {
        names.extend(ExternalVocabulary::read_tags_csv(path)?);
    }
    let vocabulary = ExternalVocabulary::new(names, &state.translations);
    *cached = Some((csv, vocabulary.clone()));
    Ok(vocabulary)
}

/// 迁入向导“标签的外部对应”：自动匹配还没有外部对应的 Eagle 标签，返回对上与没对上的。
#[tauri::command]
pub(super) async fn eagle_tag_mapping<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    lang: String,
) -> Result<EagleTagMapping, String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        let vocabulary = external_vocabulary(&app)?;
        let mapping = library
            .map_eagle_tags(&vocabulary, &lang)
            .map_err(|e| e.to_string())?;
        save_destination::publish_saved(&app, &library)?;
        Ok(mapping)
    })
    .await
}

/// 迁入向导：画师给一个标签补上外部对应。
#[tauri::command]
pub(super) async fn map_tag_external<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    tag_id: String,
    external: String,
) -> Result<MappedExternal, String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        let vocabulary = external_vocabulary(&app)?;
        let mapping = library
            .map_tag_external(&tag_id, &external, &vocabulary)
            .map_err(|e| e.to_string())?;
        save_destination::publish_saved(&app, &library)?;
        Ok(mapping)
    })
    .await
}

/// 标签管理：改某个来源名称的语言（纠正按文字判断的误判，#217）。
#[tauri::command]
pub(super) async fn set_source_name_lang<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    tag_id: String,
    name: String,
    lang: String,
) -> Result<(), String> {
    let library = save_destination::fixed_library(
        &app,
        &kinshoko_core::library::SaveDestination {
            library_id,
            folder_id: None,
        },
    )?;
    blocking(move || {
        library
            .set_source_name_lang(&tag_id, &name, &lang)
            .map_err(|e| e.to_string())?;
        save_destination::publish_saved(&app, &library)
    })
    .await
}

/// 补外部对应时的联想。外部词表属于本设备，不带资料库身份。
#[tauri::command]
pub(super) async fn external_suggestions<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    limit: u32,
) -> Result<Vec<String>, String> {
    blocking(move || Ok(external_vocabulary(&app)?.suggest(&text, limit as usize))).await
}

/// 一张参考图的内容分级（自动与有效）。
#[tauri::command]
pub(super) async fn image_rating<R: Runtime>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
) -> Result<ImageRating, String> {
    blocking(move || {
        readable(&app, &library_id)?
            .image_rating(&image_id)
            .map_err(|e| e.to_string())
    })
    .await
}
