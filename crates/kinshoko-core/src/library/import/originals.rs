//! 不经导入任务、一次进一份的原图：参考组包里的原图与订阅收进来的作品。
use super::*;

/// 把参考组包里的一份原图连同快照导入（[`crate::library::Library::import_from_package`]）。
/// 返回进库的结果与浏览列表是否变了；列表过期事件由调用方推送。
pub(in crate::library) fn import_package_original(
    inner: &Inner,
    origin: package::PackageOrigin,
    bytes: &[u8],
    snapshot: package::ImageSnapshot,
    destination: Option<SaveDestination>,
) -> (ImportOutcome, bool) {
    let (original_name, location) = (snapshot.original_name.clone(), origin.location.clone());
    ingest(
        inner,
        bytes,
        original_name,
        location,
        Origin {
            eagle: None,
            package: Some(package::PackageFacts { origin, snapshot }),
            subscription: None,
            source: MergeSource::Bytes(bytes.to_vec()),
        },
        ImportOptions::default(),
        ImportContext {
            destination: destination.unwrap_or_else(|| SaveDestination {
                library_id: inner.info.id.clone(),
                folder_id: None,
            }),
            task_created_images: Arc::new(Mutex::new(HashSet::new())),
            cancel: None,
        },
    )
}

/// 把订阅收进来的一页作品导入（[`crate::library::Library::import_from_subscription`]）。
pub(in crate::library) fn import_subscription_original(
    inner: &Inner,
    page: SubscriptionPage,
    bytes: &[u8],
    destination: Option<SaveDestination>,
) -> (ImportOutcome, bool) {
    let (original_name, location) = (page.original_name.clone(), page.location());
    ingest(
        inner,
        bytes,
        original_name,
        location,
        Origin {
            eagle: None,
            package: None,
            subscription: Some(page),
            source: MergeSource::Bytes(bytes.to_vec()),
        },
        ImportOptions::default(),
        ImportContext {
            destination: destination.unwrap_or_else(|| SaveDestination {
                library_id: inner.info.id.clone(),
                folder_id: None,
            }),
            task_created_images: Arc::new(Mutex::new(HashSet::new())),
            cancel: None,
        },
    )
}
