//! 故障注入点：只供崩溃恢复测试与 Eagle 检查工具在子进程里模拟崩溃，不在对外接口上。
//!
//! 环境变量 `KINSHOKO_FAULT=<注入点>@<第几次>`（省略 `@` 时为第 1 次）。进程第 n 次
//! 经过该注入点时立即以退出码 [`EXIT_CODE`] 结束，不运行析构、不提交事务，相当于断电或被杀。
//! 没有设置这个环境变量时注入点什么都不做。

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

const ENV: &str = "KINSHOKO_FAULT";
const EXIT_CODE: i32 = 99;

/// 导入：暂存文件已写入并校验，还没有 pending 记录。
pub(super) const IMPORT_AFTER_STAGING: &str = "import_after_staging";
/// 导入：pending 记录已提交，原文件还没有发布。
pub(super) const IMPORT_AFTER_PENDING: &str = "import_after_pending";
/// 导入：原文件已发布，参考图还没有提交。
pub(super) const IMPORT_AFTER_PUBLISH: &str = "import_after_publish";
/// 导入：提交事务里已写入参考图与来源，COMMIT 之前。
pub(super) const IMPORT_BEFORE_COMMIT: &str = "import_before_commit";

/// 永久删除：参考图记录已删除并提交，原文件还没有清除。
pub(super) const PERMANENT_DELETE_AFTER_COMMIT: &str = "permanent_delete_after_commit";

struct Armed {
    point: String,
    nth: u32,
    hits: AtomicU32,
}

fn armed() -> Option<&'static Armed> {
    static ARMED: OnceLock<Option<Armed>> = OnceLock::new();
    ARMED
        .get_or_init(|| {
            let spec = std::env::var(ENV).ok()?;
            let (point, nth) = match spec.split_once('@') {
                Some((p, n)) => (p, n.parse().ok()?),
                None => (spec.as_str(), 1),
            };
            Some(Armed {
                point: point.to_owned(),
                nth,
                hits: AtomicU32::new(0),
            })
        })
        .as_ref()
}

/// 经过注入点 `point`。
pub(super) fn hit(point: &str) {
    if let Some(armed) = armed()
        && armed.point == point
        && armed.hits.fetch_add(1, Ordering::SeqCst) + 1 == armed.nth
    {
        std::process::exit(EXIT_CODE);
    }
}
