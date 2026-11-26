//! 取锁顺序的开发期核对：按线程记下持着的许可与资源，违反顺序时立即 panic，而不是在两个线程
//! 交叉等待时死锁。发布构建里不记、不查。

#[cfg(debug_assertions)]
use std::cell::Cell;

#[cfg(debug_assertions)]
thread_local! {
    static TRANSITIONS: Cell<u32> = const { Cell::new(0) };
    static PERMITS: Cell<u32> = const { Cell::new(0) };
    static RESOURCES: Cell<u32> = const { Cell::new(0) };
}

/// 持着一把按顺序取的锁；放下时撤销记录。
pub(super) struct Held {
    #[cfg(debug_assertions)]
    kind: Kind,
}

#[cfg(debug_assertions)]
#[derive(Clone, Copy)]
enum Kind {
    Transition,
    Permit,
    Resources,
}

impl Held {
    /// 要取切换锁：此时不能持许可或资源。
    pub(super) fn transition() -> Held {
        #[cfg(debug_assertions)]
        {
            assert!(
                PERMITS.get() == 0 && RESOURCES.get() == 0,
                "取锁顺序：持可见性许可或资源锁时不能再等切换锁"
            );
            assert!(TRANSITIONS.get() == 0, "取锁顺序：切换锁不能重入");
            TRANSITIONS.set(1);
            Held {
                kind: Kind::Transition,
            }
        }
        #[cfg(not(debug_assertions))]
        Held {}
    }

    /// 要进可见性许可：此时不能持另一个许可或资源。
    pub(super) fn permit() -> Held {
        #[cfg(debug_assertions)]
        {
            assert!(PERMITS.get() == 0, "取锁顺序：可见性许可不能重入");
            assert!(
                RESOURCES.get() == 0,
                "取锁顺序：持资源锁时不能再等可见性许可"
            );
            PERMITS.set(1);
            Held { kind: Kind::Permit }
        }
        #[cfg(not(debug_assertions))]
        Held {}
    }

    /// 要取资源锁（登记表、工作区）；资源之间可以嵌套。
    pub(super) fn resources() -> Held {
        #[cfg(debug_assertions)]
        {
            RESOURCES.set(RESOURCES.get() + 1);
            Held {
                kind: Kind::Resources,
            }
        }
        #[cfg(not(debug_assertions))]
        Held {}
    }
}

#[cfg(debug_assertions)]
impl Drop for Held {
    fn drop(&mut self) {
        match self.kind {
            Kind::Transition => TRANSITIONS.set(0),
            Kind::Permit => PERMITS.set(0),
            Kind::Resources => RESOURCES.set(RESOURCES.get() - 1),
        }
    }
}
