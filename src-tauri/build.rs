use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[macro_use]
#[path = "src/command_registry.rs"]
mod command_registry;

macro_rules! command_name {
    ($name:ident) => { stringify!($name) };
    ($module:ident :: $($rest:ident)::+) => { command_name!($($rest)::+) };
}

macro_rules! command_names {
    ($($(#[$attr:meta])* $($path:ident)::+),* $(,)?) => {
        &[$(command_name!($($path)::+)),*]
    };
}

const APP_COMMANDS: &[&str] = command_registry!(app, command_names);
const LIBRARY_COMMANDS: &[&str] = command_registry!(library, command_names);
const DESKTOP_COMMANDS: &[&str] = command_registry!(desktop, command_names);

// A command omitted from the registry would otherwise be absent from both generated lists.
fn check_command_definitions(dir: &Path, remaining: &mut BTreeMap<&str, usize>) {
    for entry in fs::read_dir(dir).expect("read Rust source directory") {
        let path = entry.expect("read Rust source entry").path();
        if path.is_dir() {
            check_command_definitions(&path, remaining);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let source = fs::read_to_string(&path).expect("read Rust source");
            let file = syn::parse_file(&source)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            check_command_items(&path, &file.items, remaining);
        }
    }
}

fn check_command_items(path: &Path, items: &[syn::Item], remaining: &mut BTreeMap<&str, usize>) {
    for item in items {
        match item {
            syn::Item::Mod(module) => {
                if let Some((_, items)) = &module.content {
                    check_command_items(path, items, remaining);
                }
            }
            syn::Item::Fn(function) => {
                let command = function.attrs.iter().find(|attr| {
                    attr.path().segments.len() == 2
                        && attr.path().segments[0].ident == "tauri"
                        && attr.path().segments[1].ident == "command"
                });
                if let Some(command) = command {
                    let name = function.sig.ident.to_string();
                    if let syn::Meta::List(_) = &command.meta {
                        command
                            .parse_nested_meta(|option| {
                                if option.path.is_ident("rename") {
                                    return Err(
                                        option.error("use the function name as the IPC name")
                                    );
                                }
                                if option.input.peek(syn::Token![=]) {
                                    option.value()?.parse::<syn::Expr>()?;
                                }
                                Ok(())
                            })
                            .unwrap_or_else(|error| {
                                panic!("{}: `{name}`: {error}", path.display())
                            });
                    }
                    let count = remaining.get_mut(name.as_str()).filter(|count| **count > 0);
                    let count = count.unwrap_or_else(|| {
                        panic!(
                            "{}: `{name}` is missing from command_registry.rs",
                            path.display()
                        )
                    });
                    *count -= 1;
                }
            }
            _ => {}
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=src");
    let mut remaining = BTreeMap::new();
    for &name in [APP_COMMANDS, LIBRARY_COMMANDS, DESKTOP_COMMANDS]
        .into_iter()
        .flatten()
    {
        *remaining.entry(name).or_default() += 1;
    }
    check_command_definitions(Path::new("src"), &mut remaining);
    for (name, count) in remaining {
        assert_eq!(
            count, 0,
            "`{name}` has no matching #[tauri::command] definition"
        );
    }

    // 不用 tauri-build 的应用清单：它只嵌进可执行文件，而测试二进制用到 Tauri 的托盘与对话框代码，
    // 没有 Common Controls 6 就加载不了（STATUS_ENTRYPOINT_NOT_FOUND）。改由链接器给每个产物嵌同样的清单。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
            .plugin(
                // 资料库命令放在应用内联插件里，权限由这里生成（capabilities 中的 `library:default`）。
                "library",
                tauri_build::InlinedPlugin::new()
                    .commands(LIBRARY_COMMANDS)
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                // 截图与钉图（#62）：主窗口、框选窗口与钉图菜单窗口都用 `desktop:default`。
                "desktop",
                tauri_build::InlinedPlugin::new()
                    .commands(DESKTOP_COMMANDS)
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            ),
    )
    .expect("tauri-build 失败");
}
