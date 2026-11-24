//! 应用壳信息：前端标题栏与“关于”显示用，也是 ts-rs 契约的第一条类型。

use kinshoko_core::app_info;

#[test]
fn app_info_names_the_product_and_reports_the_build_version() {
    let info = app_info();

    assert_eq!(info.product_name, "Kinshoko");
    // 跟着工作区版本走：发版时 prepare-release 改了 Cargo.toml，这里不用跟着改。
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
}

#[test]
fn app_info_crosses_the_ipc_boundary_in_camel_case() {
    let json = serde_json::to_value(app_info()).unwrap();

    assert_eq!(
        json,
        serde_json::json!({ "productName": "Kinshoko", "version": env!("CARGO_PKG_VERSION") })
    );
}
