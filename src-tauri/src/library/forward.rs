//! 活动资料库的装配与事件转发（从 library.rs 原样搬出）。

use super::*;

/// 核心已完成切换，这里装配新的活动资料库：设上保存的安全模式、取走参考视角、清掉旧库的
/// Search 快照、为它开始打标，并转发它的事件。每个活动句柄只装配一次；事件按句柄转发，
/// 切换后旧句柄（例如导入仍持有的库）的事件照常带着它的资料库身份送到界面。
///
/// 新打开的资料库在核心里先是封存状态（安全模式开），这里再按设置放开。
pub(super) fn forward_events<R: Runtime>(
    app: &AppHandle<R>,
    state: &LibraryState,
    library: Arc<Library>,
) -> LibraryInfo {
    let info = library.info().clone();
    let weak = Arc::downgrade(&library);
    let mut forwarded = lock(&state.forwarded);
    if forwarded
        .as_ref()
        .is_some_and(|previous| Weak::ptr_eq(previous, &weak))
    {
        return info;
    }
    *forwarded = Some(weak.clone());
    library.set_safe_mode(saved_safe_mode(app));
    if let Err(error) = with_catalog(&state.search, |catalog| catalog.synchronize(&library)) {
        crate::run_log::error("接入统一标签目录失败", error);
    }
    state.configure_library(&library);
    let events = library.events();
    *lock(&state.reference) = library.take_reference_lens();
    // 刚成为活动库的库不再经只读视角读取；其他库按需重开。
    state.detached.clear();
    state.search.invalidate();
    crate::tagging::attach(app, library);
    let mut handles = lock(&state.forwarded_handles);
    handles.retain(|handle| handle.strong_count() > 0);
    if handles.iter().any(|handle| Weak::ptr_eq(handle, &weak)) {
        return info;
    }
    handles.push(weak);
    drop(handles);
    let (app, search) = (app.clone(), state.search.clone());
    // 每个句柄的事件都转发，直到句柄关闭（ADR-0008）：可写句柄切到别的库后，原库仍在进行的导入的
    // 进度、结束与列表变化照常送到界面。事件都带资料库身份，界面只采纳它正在显示的库的安全模式与
    // 导入事件，不串台。
    std::thread::Builder::new()
        .name("kinshoko-library-events".into())
        .spawn(move || {
            // 自动打标每写一张图都有图片与词表变化：合并后再送到界面，免得每张图都让界面重读一遍、
            // 在后端阻塞线程池里排起长队（#142）。
            kinshoko_core::library::forward_coalesced(events, EVENT_COALESCE, |mut event| {
                // 有新图进库：自动标签立即检查，不等下一次轮询。
                if matches!(event, LibraryEvent::ListStale { .. }) {
                    crate::tagging::wake(&app);
                }
                // 先清掉旧快照再通知前端，前端收到事件后的查找用的是新词表。
                // 安全模式切换后词表计数与可见的标签都变了。
                if matches!(
                    event,
                    LibraryEvent::VocabularyChanged { .. }
                        | LibraryEvent::ImagesChanged { .. }
                        | LibraryEvent::ListStale { .. }
                        | LibraryEvent::SafeModeChanged { .. }
                ) {
                    search.invalidate();
                }
                // Task-finished events may race the all-provider projection. Raw success details
                // stay in the fixed task owner; polling returns the checked ordinary receipt.
                if let LibraryEvent::TaskFinished { report, .. } = &mut event {
                    *report = report.clone().without_content_details();
                }
                let _ = app.emit(EVENT, event);
            });
        })
        .expect("无法启动事件转发线程");
    info
}
