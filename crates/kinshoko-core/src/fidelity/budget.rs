//! 整图解码的内存预算（#165）。
//!
//! 派生图要先把原图整张解码成 RGBA f32 线性光；几十张缺缓存的大图同时渲染会耗尽内存，
//! 分配失败时进程直接 abort。同时在进行的整图解码按估算内存（像素数 × 每像素字节数）
//! 合计不超过一个全进程上限，不按请求数或线程数计：浏览时现场生成缩略图、补缺失档位、
//! 补占位图与导入时的校验解码都经过同一个 [`DECODE`]。超过上限的请求排队，按到达顺序放行。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::description::{ColourDeclaration, ColourModel};
use super::inspect::Inspection;

/// 同时在进行的整图解码估算内存上限（全进程）。常见参考图（几百万到一千多万像素）仍能几张并行；
/// 超过上限的一张单独解码，峰值与串行时相同。
const DECODE_BUDGET_BYTES: u64 = 1536 * 1024 * 1024;

pub(crate) static DECODE: MemoryBudget = MemoryBudget::new(DECODE_BUDGET_BYTES);

/// 一次整图渲染的峰值估算（字节）。普通来源：解码器的工作缓冲与解码出的源像素（≤ 8 B）、
/// 线性光 f32（16 B），转正为旋转时再多一份 f32；实测 41.5 MP 的 JPEG 单张峰值约 34 B／像素，
/// 取 40 B 留余量。HDR 色调映射多一份 f32，CMYK 的中间缓冲更多。
pub(crate) fn estimate(inspection: &Inspection) -> u64 {
    let d = &inspection.description;
    let per_pixel = if d.colour_model == ColourModel::Cmyk {
        72
    } else if d.declaration == ColourDeclaration::Cicp
        && d.cicp.is_some_and(|c| matches!(c.transfer, 16 | 18))
    {
        56
    } else {
        40
    };
    u64::from(inspection.width) * u64::from(inspection.height) * per_pixel
}

/// 占着整图解码预算：持有它才能调用 `render::render_sdr_widths`。
pub(crate) struct DecodePermit {
    _held: BudgetPermit,
}

/// 等到预算够用，为这张图占用整图解码预算。`cancel` 置位时放弃等待，返回 `None`。
pub(crate) fn decode(inspection: &Inspection, cancel: Option<&AtomicBool>) -> Option<DecodePermit> {
    DECODE
        .acquire(estimate(inspection), cancel)
        .map(|held| DecodePermit { _held: held })
}

/// 按字节数计的内存预算：先到先得，单项超过上限时等其他占用都放开后独占。
pub(crate) struct MemoryBudget {
    limit: AtomicU64,
    state: Mutex<BudgetState>,
    released: Condvar,
}

struct BudgetState {
    in_use: u64,
    next_ticket: u64,
    /// 还在等待的请求，按到达顺序：只有排在最前的那个能占用，大图不会被源源不断的小图饿着。
    waiting: VecDeque<u64>,
}

impl MemoryBudget {
    pub(crate) const fn new(limit: u64) -> Self {
        Self {
            limit: AtomicU64::new(limit),
            state: Mutex::new(BudgetState {
                in_use: 0,
                next_ticket: 0,
                waiting: VecDeque::new(),
            }),
            released: Condvar::new(),
        }
    }

    /// 等到排到自己、预算也够用时占用。任务在等待中被取消时返回 `None`，这一项不再继续。
    pub(crate) fn acquire(
        &'static self,
        amount: u64,
        cancel: Option<&AtomicBool>,
    ) -> Option<BudgetPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.waiting.push_back(ticket);
        loop {
            let limit = self.limit.load(Ordering::SeqCst);
            let amount = amount.min(limit);
            if state.waiting.front() == Some(&ticket) && state.in_use + amount <= limit {
                state.waiting.pop_front();
                state.in_use += amount;
                // 下一个可能也放得下。
                self.released.notify_all();
                return Some(BudgetPermit {
                    budget: self,
                    amount,
                });
            }
            if cancel.is_some_and(|cancel| cancel.load(Ordering::SeqCst)) {
                state.waiting.retain(|&t| t != ticket);
                self.released.notify_all();
                return None;
            }
            // 取消不经过这把锁，定时醒来看一眼。
            state = self
                .released
                .wait_timeout(state, Duration::from_millis(50))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

pub(crate) struct BudgetPermit {
    budget: &'static MemoryBudget,
    amount: u64,
}

impl Drop for BudgetPermit {
    fn drop(&mut self) {
        let mut state = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        state.in_use -= self.amount;
        self.budget.released.notify_all();
    }
}

/// 同时在进行的整图渲染的估算内存与渲染次数（全进程）。只记录，不限制；给回归测试观察。
static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);
static RENDERS: AtomicU64 = AtomicU64::new(0);

/// 一次整图渲染在进行中；放开时从 [`IN_FLIGHT`] 减去。
pub(crate) struct Rendering(u64);

pub(crate) fn rendering(bytes: u64) -> Rendering {
    RENDERS.fetch_add(1, Ordering::SeqCst);
    let now = IN_FLIGHT.fetch_add(bytes, Ordering::SeqCst) + bytes;
    PEAK.fetch_max(now, Ordering::SeqCst);
    Rendering(bytes)
}

impl Drop for Rendering {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(self.0, Ordering::SeqCst);
    }
}

/// 观察整图渲染、调整预算。只给回归测试用。
#[doc(hidden)]
pub mod probe {
    use super::*;

    /// 调整全进程的整图解码预算（字节）。
    pub fn set_budget(bytes: u64) {
        DECODE.limit.store(bytes, Ordering::SeqCst);
        DECODE.released.notify_all();
    }

    /// 自上次 [`reset`] 以来，同时在进行的整图渲染估算内存的最大值（字节）。
    pub fn peak() -> u64 {
        PEAK.load(Ordering::SeqCst)
    }

    /// 至今的整图渲染次数。
    pub fn renders() -> u64 {
        RENDERS.load(Ordering::SeqCst)
    }

    pub fn reset() {
        PEAK.store(IN_FLIGHT.load(Ordering::SeqCst), Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: u64 = 1000;

    fn budget() -> &'static MemoryBudget {
        Box::leak(Box::new(MemoryBudget::new(LIMIT)))
    }

    #[test]
    fn decodes_over_the_budget_wait_until_earlier_ones_finish() {
        let budget = budget();
        let first = budget.acquire(LIMIT / 2, None).unwrap();
        let second = budget.acquire(LIMIT / 2, None).unwrap();
        let (sender, entered) = std::sync::mpsc::channel();
        let third = std::thread::spawn(move || {
            let _permit = budget.acquire(1, None).unwrap();
            sender.send(()).unwrap();
        });
        assert!(entered.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first);
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        third.join().unwrap();
        drop(second);
    }

    #[test]
    fn a_cancelled_task_stops_waiting_for_the_budget() {
        let budget = budget();
        let _held = budget.acquire(LIMIT, None).unwrap();
        let cancel = AtomicBool::new(true);
        assert!(budget.acquire(1, Some(&cancel)).is_none());
        // 放弃的请求不再挡住后来的。
        assert!(budget.state.lock().unwrap().waiting.is_empty());
    }

    #[test]
    fn an_image_larger_than_the_budget_still_decodes_alone() {
        let budget = budget();
        drop(budget.acquire(LIMIT * 4, None).unwrap());
        assert_eq!(budget.state.lock().unwrap().in_use, 0);
    }

    #[test]
    fn a_large_request_is_not_overtaken_by_later_small_ones() {
        let budget = budget();
        let held = budget.acquire(LIMIT / 2, None).unwrap();
        let (sender, order) = std::sync::mpsc::channel();
        let large = {
            let sender = sender.clone();
            std::thread::spawn(move || {
                let _permit = budget.acquire(LIMIT, None).unwrap();
                sender.send("large").unwrap();
            })
        };
        while budget.state.lock().unwrap().waiting.is_empty() {
            std::thread::yield_now();
        }
        let small = std::thread::spawn(move || {
            let _permit = budget.acquire(1, None).unwrap();
            sender.send("small").unwrap();
        });
        // 小的那个放得下，但排在大的后面。
        assert!(order.recv_timeout(Duration::from_millis(100)).is_err());
        drop(held);
        assert_eq!(order.recv_timeout(Duration::from_secs(5)).unwrap(), "large");
        assert_eq!(order.recv_timeout(Duration::from_secs(5)).unwrap(), "small");
        large.join().unwrap();
        small.join().unwrap();
    }
}
