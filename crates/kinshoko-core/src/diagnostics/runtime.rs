//! 本窗口实际测得的渲染能力。只接受固定状态，不接收文件名、路径、图片或任意浏览器错误文字。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `Available` 表示完成了内置样本的相应操作，不表示图片色彩正确。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CapabilityCheck {
    Available,
    Missing,
    Failed,
    TimedOut,
}

/// 当前生产钉图渲染器选择的后备存储。float16 是可降级能力，不是浏览前提。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CanvasBuffer {
    Float16,
    Uint8,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RuntimeCapabilities {
    pub image_decode: CapabilityCheck,
    pub canvas_2d: CapabilityCheck,
    pub canvas_buffer: CanvasBuffer,
}

/// 仅列检查实际失败的原因。不根据 OS、Runtime 版本或可选 API 推断。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeAssessment {
    pub problems: Vec<String>,
    pub uses_8bit_fallback: bool,
}

/// WebView2 可用版本查询与本窗口能力检查。版本查询不独立证明实际运行进程的版本。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeStatus {
    pub webview2: Option<String>,
    pub assessment: RuntimeAssessment,
}

impl RuntimeCapabilities {
    pub fn assess(&self) -> RuntimeAssessment {
        let mut problems = Vec::new();
        let decode = match self.image_decode {
            CapabilityCheck::Available => None,
            CapabilityCheck::Missing => Some(
                "当前 WebView2 缺少图片解码接口（HTMLImageElement.decode），钉图无法读取图片。",
            ),
            CapabilityCheck::Failed => {
                Some("当前 WebView2 未能解码内置 PNG 样本，参考图显示能力未确认。")
            }
            CapabilityCheck::TimedOut => Some("内置 PNG 解码检查超时，参考图显示能力未确认。"),
        };
        if let Some(reason) = decode {
            problems.push(reason.to_owned());
        }
        let canvas = match self.canvas_2d {
            CapabilityCheck::Available => None,
            CapabilityCheck::Missing => Some("当前 WebView2 无法建立二维画布，钉图无法显示。"),
            CapabilityCheck::Failed => {
                Some("当前 WebView2 未能完成二维绘制检查，钉图显示能力未确认。")
            }
            CapabilityCheck::TimedOut => Some("二维绘制检查超时，钉图显示能力未确认。"),
        };
        if let Some(reason) = canvas {
            problems.push(reason.to_owned());
        }
        RuntimeAssessment {
            problems,
            uses_8bit_fallback: self.canvas_2d == CapabilityCheck::Available
                && self.canvas_buffer == CanvasBuffer::Uint8,
        }
    }

    pub(super) fn describe(&self) -> String {
        let check = |state| match state {
            CapabilityCheck::Available => "完成",
            CapabilityCheck::Missing => "缺少接口或上下文",
            CapabilityCheck::Failed => "操作失败",
            CapabilityCheck::TimedOut => "检查超时",
        };
        let buffer = match self.canvas_buffer {
            CanvasBuffer::Float16 => "float16（运行时声明的后备存储）",
            CanvasBuffer::Uint8 => "8 位降级",
            CanvasBuffer::Unavailable => "不可用",
        };
        let mut out = format!(
            "内置 PNG 解码：{}\n钉图二维绘制与基础像素读回：{}\n钉图画布：{buffer}\n检查范围只含基础解码与绘制，不代表色彩门槛通过。\n",
            check(self.image_decode),
            check(self.canvas_2d),
        );
        for reason in self.assess().problems {
            out.push_str(&reason);
            out.push('\n');
        }
        out
    }
}
