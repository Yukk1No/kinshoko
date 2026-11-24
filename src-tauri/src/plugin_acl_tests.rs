//! 内联插件注册的命令都要在 `build.rs` 的权限清单里（#225）。漏了的命令被 ACL 拒绝，页面只拿到一个
//! 被吞掉的 rejected promise：#193 加的 `pin_layer_pins` 漏了，新建的钉图层取不到第一个钉图，
//! 截图钉图卡 5 秒后没有出现，它的窗口区域却留着接点击。

use std::collections::BTreeSet;

const BUILD: &str = include_str!("../build.rs");

/// `build.rs` 里插件 `plugin` 的 `.commands(&[...])` 清单。
fn allowed(plugin: &str) -> BTreeSet<String> {
    let start = BUILD
        .find(&format!("\"{plugin}\","))
        .unwrap_or_else(|| panic!("build.rs 里没有插件 {plugin}"));
    let rest = &BUILD[start..];
    let list = &rest[rest.find(".commands(&[").expect("插件没有命令清单")..];
    let list = &list[..list.find("])").expect("命令清单没有结束")];
    list.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

/// 源文件里 `generate_handler![...]` 注册的命令名（去掉模块路径）。
fn registered(source: &str) -> BTreeSet<String> {
    let start = source
        .find("generate_handler![")
        .expect("没有 generate_handler!");
    let list = &source[start + "generate_handler![".len()..];
    let list = &list[..list.find(']').expect("generate_handler! 没有结束")];
    list.split(',')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| c.rsplit("::").next().unwrap_or(c).to_owned())
        .collect()
}

#[test]
fn desktop_commands_are_all_permitted() {
    let source = include_str!("desktop/mod.rs");
    assert_eq!(registered(source), allowed("desktop"));
}

#[test]
fn library_commands_are_all_permitted() {
    let source = include_str!("library.rs");
    assert_eq!(registered(source), allowed("library"));
}
