//! 资料库钉图的原位遮蔽（#60、#65）。
//!
//! 安全模式是本设备的应用设置：开关时应用壳直接调用 [`PinVeils::set_safe_mode`]，调整范围时
//! 调用 [`PinVeils::set_scope`]，不经资料库事件——没有打开资料库时也一样，已显示的钉图随即
//! 重新核对。钉图是否在范围内由参考视角按同一个范围核对（`ReferenceImage::sealed`）。

use std::collections::HashSet;

use super::{PinContent, SavedPin};
use crate::library::SafeModeScope;

/// 安全模式开关、范围与画师逐张确认显示的钉图。不是线程安全的；应用壳把它放在锁里。
#[derive(Debug, Clone, Default)]
pub struct PinVeils {
    safe_mode: bool,
    scope: SafeModeScope,
    /// 确认显示的钉图（只在本次运行、安全模式再开启前有效）。
    revealed: HashSet<String>,
}

impl PinVeils {
    /// 默认范围；应用壳随后按设置调用 [`Self::set_scope`]。
    pub fn new(safe_mode: bool) -> PinVeils {
        PinVeils {
            safe_mode,
            scope: SafeModeScope::default(),
            revealed: HashSet::new(),
        }
    }

    pub fn safe_mode(&self) -> bool {
        self.safe_mode
    }

    pub fn scope(&self) -> SafeModeScope {
        self.scope
    }

    /// 安全模式范围变了时返回 true：全部资料库钉图要重新核对。收紧（范围变大）时之前的确认
    /// 作废，放宽时保留（#223）。
    pub fn set_scope(&mut self, scope: SafeModeScope) -> bool {
        if self.scope == scope {
            return false;
        }
        if self.scope.tightened_by(scope) {
            self.revealed.clear();
        }
        self.scope = scope;
        true
    }

    /// 安全模式开关变了时返回 true：全部资料库钉图要重新核对。开启时之前的确认作废。
    pub fn set_safe_mode(&mut self, on: bool) -> bool {
        if self.safe_mode == on {
            return false;
        }
        self.safe_mode = on;
        if on {
            self.revealed.clear();
        }
        true
    }

    /// 画师确认显示这一张。
    pub fn reveal(&mut self, pin: &str) {
        self.revealed.insert(pin.to_owned());
    }

    /// 钉图关闭了：确认不留。
    pub fn forget(&mut self, pin: &str) {
        self.revealed.remove(pin);
    }

    /// 钉图要不要原位遮蔽。`sealed` 是经参考视角核对的结果；资料库没打开、图已不在、
    /// 核对不了时为 `None`，安全模式开启时按被封印处理。截图钉图从不遮蔽。
    pub fn veiled(&self, pin: &SavedPin, sealed: Option<bool>) -> bool {
        matches!(pin.content, PinContent::Reference { .. })
            && self.safe_mode
            && !self.revealed.contains(&pin.id)
            && sealed.unwrap_or(true)
    }
}
