//! 有全屏程序或演示模式时让出打标（#212）。显卡档打标与游戏平分 GPU，降优先级与限速都挡不住卡顿；
//! 维护者的决定是这时自动暂停，回到平常状态后继续。判定只看系统报告的通知状态与前台窗口归属，
//! 读取系统状态由应用壳实现（[`super::TaggingConfig::foreground`]）。

/// 应用壳提供的检查：现在是否要让出打标（通常由 [`yields_to_foreground`] 按系统状态判定）。
#[derive(Clone)]
pub struct ForegroundCheck(std::sync::Arc<dyn Fn() -> bool + Send + Sync>);

impl ForegroundCheck {
    pub fn new(yields: impl Fn() -> bool + Send + Sync + 'static) -> ForegroundCheck {
        ForegroundCheck(std::sync::Arc::new(yields))
    }

    pub fn yields(&self) -> bool {
        (self.0)()
    }
}

impl std::fmt::Debug for ForegroundCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ForegroundCheck")
    }
}

/// 系统报告的“现在适不适合打扰用户”：`SHQueryUserNotificationState` 的 QUERY_USER_NOTIFICATION_STATE。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserNotificationState {
    /// 屏保在运行、锁屏或正在切换用户。
    NotPresent,
    /// 全屏程序或其他“忙碌”状态（截图框选、钉图菜单这类置顶全屏窗口也会被判成这个，#230）。
    Busy,
    /// 全屏 Direct3D 程序（游戏）。
    RunningD3dFullScreen,
    /// 演示模式。
    PresentationMode,
    /// 平常状态。
    AcceptsNotifications,
    /// 系统安装后第一个小时的安静期。
    QuietTime,
    /// Windows 应用商店应用在前台。
    App,
}

impl UserNotificationState {
    /// 系统返回的整数值；不认识的值为 `None`。
    pub fn from_raw(value: i32) -> Option<UserNotificationState> {
        Some(match value {
            1 => UserNotificationState::NotPresent,
            2 => UserNotificationState::Busy,
            3 => UserNotificationState::RunningD3dFullScreen,
            4 => UserNotificationState::PresentationMode,
            5 => UserNotificationState::AcceptsNotifications,
            6 => UserNotificationState::QuietTime,
            7 => UserNotificationState::App,
            _ => return None,
        })
    }
}

/// 打标是否要让出：另一个程序全屏、忙碌或在演示时让出；前台是 Kinshoko 自己的窗口时不让
/// （截图框选与钉图菜单打开时系统同样报忙碌，不能因此停下）。读不到状态时照常打标。
pub fn yields_to_foreground(
    state: Option<UserNotificationState>,
    foreground_is_ours: bool,
) -> bool {
    !foreground_is_ours
        && matches!(
            state,
            Some(
                UserNotificationState::Busy
                    | UserNotificationState::RunningD3dFullScreen
                    | UserNotificationState::PresentationMode
            )
        )
}
