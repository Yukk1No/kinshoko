fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            // 资料库命令放在应用内联插件里，权限由这里生成（capabilities 中的 `library:default`）。
            "library",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "current_library",
                    "create_library",
                    "browse",
                    "image",
                    "edit",
                    "sidebar",
                    "create_folder",
                    "rename_folder",
                    "move_folder",
                    "recovery",
                    "start_import",
                    "cancel_import",
                    "pick_folder",
                    "pick_files",
                    "image_tags",
                    "edit_tags",
                    "vocabulary",
                    "tag_groups",
                    "image_rating",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("tauri-build 失败");
}
