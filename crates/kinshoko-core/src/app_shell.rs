//! 应用壳：本设备上与具体资料库无关的信息。

use serde::Serialize;
use ts_rs::TS;

/// 应用本身的名称与版本，供标题栏和“关于”显示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub product_name: String,
    pub version: String,
}

pub fn app_info() -> AppInfo {
    AppInfo {
        product_name: "Kinshoko".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}
