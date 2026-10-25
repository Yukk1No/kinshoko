//! 核心 crate 的大部分集成测试合成这一个测试二进制：每个测试二进制都要各自链接一遍核心与
//! 全部依赖，在 Windows 上编译测试的大半时间花在链接上。新的测试文件在这里加一行 `mod`。
//!
//! 仍是独立二进制的（Cargo.toml 的 `[[test]]`）：以子进程重跑自身某个测试的（崩溃注入、
//! 打标子进程），它们按不带模块前缀的测试名过滤；依赖全进程状态的 `thumbnail_memory`（解码预算）
//! 与 `import_pipeline`（导入时预先生成的网格档位）；验收文档按目标名引用的 `fidelity`
//! （`--test fidelity`）。
//!
//! 每个模块都用 `#[path]` 引入：这样它们按目录模块解析，文件里原有的 `mod support;`、
//! `#[path = "support/eagle.rs"] mod eagle;` 仍相对 `tests/`，同一份辅助代码各自一份。
//!
//! 合进来的测试在 `cargo test` 下同进程并发，不能依赖全进程状态的初始值。

#![allow(clippy::duplicate_mod)]

#[path = "app_info.rs"]
mod app_info;
#[path = "app_settings.rs"]
mod app_settings;
#[path = "approx_library.rs"]
mod approx_library;
#[path = "approx_search.rs"]
mod approx_search;
#[path = "backup_eagle.rs"]
mod backup_eagle;
#[path = "backup_plan.rs"]
mod backup_plan;
#[path = "backup_restore.rs"]
mod backup_restore;
#[path = "backup_scope.rs"]
mod backup_scope;
#[path = "browse_cursor.rs"]
mod browse_cursor;
#[path = "browse_search.rs"]
mod browse_search;
#[path = "capture_history.rs"]
mod capture_history;
#[path = "capture_readout.rs"]
mod capture_readout;
#[path = "capture_region.rs"]
mod capture_region;
#[path = "catalog_approx.rs"]
mod catalog_approx;
#[path = "catalog_groups.rs"]
mod catalog_groups;
#[path = "catalog_search.rs"]
mod catalog_search;
#[path = "catalog_source_names.rs"]
mod catalog_source_names;
#[path = "catalog_visibility.rs"]
mod catalog_visibility;
#[path = "data_dirs.rs"]
mod data_dirs;
#[path = "device.rs"]
mod device;
#[path = "device_libraries.rs"]
mod device_libraries;
#[path = "diagnostics.rs"]
mod diagnostics;
#[path = "downscale.rs"]
mod downscale;
#[path = "eagle_import.rs"]
mod eagle_import;
#[path = "eagle_reimport.rs"]
mod eagle_reimport;
#[path = "eagle_source_names.rs"]
mod eagle_source_names;
#[path = "eagle_tag_collisions.rs"]
mod eagle_tag_collisions;
#[path = "eagle_tag_mapping.rs"]
mod eagle_tag_mapping;
#[path = "edge_hide.rs"]
mod edge_hide;
#[path = "global_shortcuts.rs"]
mod global_shortcuts;
#[path = "image_commands.rs"]
mod image_commands;
#[path = "import_preview.rs"]
mod import_preview;
#[path = "import_recovery.rs"]
mod import_recovery;
#[path = "inspector_reads.rs"]
mod inspector_reads;
#[path = "library.rs"]
mod library;
#[path = "library_batch.rs"]
mod library_batch;
#[path = "model_package.rs"]
mod model_package;
#[path = "organize.rs"]
mod organize;
#[path = "pin_geometry.rs"]
mod pin_geometry;
#[path = "pin_menu.rs"]
mod pin_menu;
#[path = "pin_menu_window.rs"]
mod pin_menu_window;
#[path = "pin_motion.rs"]
mod pin_motion;
#[path = "pin_placement.rs"]
mod pin_placement;
#[path = "pin_restore.rs"]
mod pin_restore;
#[path = "pin_veil.rs"]
mod pin_veil;
#[path = "placeholder.rs"]
mod placeholder;
#[path = "rating.rs"]
mod rating;
#[path = "rating_search.rs"]
mod rating_search;
#[path = "reference_capture.rs"]
mod reference_capture;
#[path = "reference_capture_actions/main.rs"]
mod reference_capture_actions;
#[path = "reference_group_capture_backup.rs"]
mod reference_group_capture_backup;
#[path = "reference_group_capture_links.rs"]
mod reference_group_capture_links;
#[path = "reference_group_captures.rs"]
mod reference_group_captures;
#[path = "reference_group_package.rs"]
mod reference_group_package;
#[path = "reference_group_resolve.rs"]
mod reference_group_resolve;
#[path = "reference_group_snapshot.rs"]
mod reference_group_snapshot;
#[path = "reference_groups.rs"]
mod reference_groups;
#[path = "reference_pin.rs"]
mod reference_pin;
#[path = "run_log.rs"]
mod run_log;
#[path = "safe_mode.rs"]
mod safe_mode;
#[path = "safe_mode_scope.rs"]
mod safe_mode_scope;
#[path = "safe_mode_scope_workspace.rs"]
mod safe_mode_scope_workspace;
#[path = "save_destination.rs"]
mod save_destination;
#[path = "search.rs"]
mod search;
#[path = "search_cache.rs"]
mod search_cache;
#[path = "source_actions.rs"]
mod source_actions;
#[path = "tag_catalog.rs"]
mod tag_catalog;
#[path = "tag_names.rs"]
mod tag_names;
#[path = "tagging/main.rs"]
mod tagging;
#[path = "tagging_log.rs"]
mod tagging_log;
#[path = "tagging_yield.rs"]
mod tagging_yield;
#[path = "tags.rs"]
mod tags;
#[path = "translations.rs"]
mod translations;
#[path = "ui_scale.rs"]
mod ui_scale;
#[path = "update_policy.rs"]
mod update_policy;
#[path = "viewer.rs"]
mod viewer;
#[path = "workspace.rs"]
mod workspace;
#[path = "workspace_folders.rs"]
mod workspace_folders;
#[path = "workspace_thumbnails.rs"]
mod workspace_thumbnails;
#[path = "writer_switch.rs"]
mod writer_switch;
