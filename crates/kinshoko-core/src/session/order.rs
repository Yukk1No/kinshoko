//! 开发构建按线程核对取锁顺序，在交叉等待前立即 panic。

#[cfg(debug_assertions)]
use std::cell::Cell;

#[cfg(debug_assertions)]
thread_local! {
    static HELD: Cell<u8> = const { Cell::new(0) };
}

#[derive(Clone, Copy, Debug)]
enum Level {
    Transition,
    Permit,
    Libraries,
    Catalog,
    Workspace,
}

/// 持着一把按顺序取的锁；放下时撤销记录。
pub(crate) struct Held {
    #[cfg(debug_assertions)]
    level: Level,
}

impl Held {
    pub(super) fn transition() -> Self {
        Self::acquire(Level::Transition)
    }

    pub(super) fn permit() -> Self {
        Self::acquire(Level::Permit)
    }

    pub(super) fn libraries() -> Self {
        Self::acquire(Level::Libraries)
    }

    /// 非阻塞取锁已经成功，允许从目录或工作区取登记表供日志读取。
    pub(super) fn try_libraries() -> Self {
        #[cfg(debug_assertions)]
        {
            let level = Level::Libraries;
            let bit = 1 << level as u8;
            let held = HELD.get();
            assert_eq!(held & bit, 0, "取锁顺序：Libraries 不能重入");
            HELD.set(held | bit);
            Self { level }
        }
        #[cfg(not(debug_assertions))]
        Self {}
    }

    pub(crate) fn catalog() -> Self {
        Self::acquire(Level::Catalog)
    }

    pub(super) fn workspace() -> Self {
        Self::acquire(Level::Workspace)
    }

    fn acquire(_level: Level) -> Self {
        #[cfg(debug_assertions)]
        {
            let bit = 1 << _level as u8;
            let held = HELD.get();
            assert!(
                held < bit,
                "取锁顺序：不能在持有同级或更高一级锁时获取 {_level:?}"
            );
            HELD.set(held | bit);
            Self { level: _level }
        }
        #[cfg(not(debug_assertions))]
        Self {}
    }
}

#[cfg(debug_assertions)]
impl Drop for Held {
    fn drop(&mut self) {
        HELD.set(HELD.get() & !(1 << self.level as u8));
    }
}
