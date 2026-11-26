//! In-process notifications. Only the window adapter translates them to Tauri events.

use kinshoko_core::backup::BackupStatus;
use kinshoko_core::desktop::CaptureEntry;
use kinshoko_core::library::{LibraryEvent, LibraryInfo, SafeMode};
use kinshoko_core::subscription::SubscriptionStatus;
use kinshoko_core::tagging::TaggingStatus;
use kinshoko_core::workspace::WorkspaceStatus;
use kinshoko_core::{OrganizeWaiting, UpdateProgress};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) enum AppNotice {
    Library(LibraryEvent),
    WritableLibraryChanged(LibraryInfo),
    OrganizeWaiting(OrganizeWaiting),
    RegistryChanged,
    LibraryWriteCommitted,
    TagGroupsChanged,
    PersonalApproxChanged,
    CatalogLabelsChanged(Option<VocabularyRevision>),
    MainWindowActivated,
    WorkspaceChanged(WorkspaceStatus),
    SafeModeCommitted(SafeMode),
    ApplicationSettingsRestored(SafeMode),
    ReferenceGroupsChanged,
    DeskChanged,
    DeskGroupStarted {
        group_id: String,
        previous_id: String,
    },
    CaptureHistoryChanged(Vec<CaptureEntry>),
    OpenInKinshokoRequested,
    CaptureCollectionRequested,
    InterfaceLanguageChanged(String),
    BackupStatus(Box<BackupStatus>),
    SubscriptionStatus(SubscriptionStatus),
    TaggingStatus(TaggingStatus),
    UpdateChannelChanged,
    UpdateProgress(UpdateProgress),
}

pub(crate) struct VocabularyRevision {
    pub(crate) library_id: String,
    pub(crate) revision: i64,
}

type Subscriber<R> = fn(&AppHandle<R>, &AppNotice);

pub(crate) struct AppNotices<R: Runtime>(Vec<Subscriber<R>>);

impl<R: Runtime> AppNotices<R> {
    pub(crate) fn new(subscribers: Vec<Subscriber<R>>) -> Self {
        Self(subscribers)
    }
}

/// Deliver in registration order. Publishers keep responsibility for commit and lock
/// boundaries. Subscribers that need to read from disk or wait on the publisher's
/// locks must dispatch that work off-thread. A subscriber may publish another notice.
pub(crate) fn publish<R: Runtime>(app: &AppHandle<R>, notice: AppNotice) {
    for subscriber in &app.state::<AppNotices<R>>().0 {
        subscriber(app, &notice);
    }
}
