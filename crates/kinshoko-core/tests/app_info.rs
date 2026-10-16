//! 应用壳信息：前端标题栏与“关于”显示用，也是 ts-rs 契约的第一条类型。

use kinshoko_core::app_info;

#[test]
fn app_info_names_the_product_and_reports_the_build_version() {
    let info = app_info();

    assert_eq!(info.product_name, "Kinshoko");
    assert_eq!(info.version, "0.1.0");
}

#[test]
fn app_info_crosses_the_ipc_boundary_in_camel_case() {
    let json = serde_json::to_value(app_info()).unwrap();

    assert_eq!(
        json,
        serde_json::json!({ "productName": "Kinshoko", "version": "0.1.0" })
    );
}
