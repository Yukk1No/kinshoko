//! 派生图管线：解码 → 按来源色彩声明转到线性光工作空间 → 转正方向 → 预乘缩放 → 无损编码。

use super::description::Cicp;

/// 能按 cICP 解释的原色与传递函数（与 Chromium 支持的常见组合一致）。
pub(crate) fn cicp_supported(cicp: Cicp) -> bool {
    matches!(cicp.primaries, 1 | 9 | 12)
        && matches!(cicp.transfer, 1 | 6 | 8 | 13 | 14 | 15 | 16 | 18)
}
