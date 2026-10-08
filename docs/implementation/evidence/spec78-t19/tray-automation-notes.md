# 托盘自动化原始失败与最终方法

最终结果以 `report.json`、`old-tray-exit.json` 和 `new-tray-exit.json` 为准。方法为 `automated-native-menu-dispatch`，不是人工操作。

首次 native 尝试以 `sky.list_windows()` 回读独立程序的主窗口与钉图。`sky.get_window_state()` 返回 `Computer Use app approval timed out`，没有取得截图或文本；这不是 sandbox auto-review 拒绝。

随后按实际 tray-icon 0.25.1 源码，核对独立程序 PID/path，向其 `tray_icon_app` 投递 6002 / WM_RBUTTONUP，实际 `#32768` 菜单出现。`old-tray-open.json` 保存回读的真实菜单与末项“退出”id。给 popup 发送 End/Enter 消息未退出；尝试 SendInput 前的 foreground PID guard 返回 `{'foreground': 131350, 'pid': 25200, 'expected': 13692}` 并抛出 AssertionError。没有向其他程序发送键盘输入。

这次 15 分钟正常退出等待超时，`report-tray-timeout.json`、对应日志及旧版截图保存失败原件。harness 的 finally 清理自己的 driver 树；这次清理不记为正常退出。

第二次仅 dispatch 真实菜单 id，菜单的 TrackPopupMenu 模态循环未收起，30 秒退出等待失败，保存 `report-menu-modal-red.json`、`old-tray-menu-modal-red.json` 和对应日志。

最终 `e2e/native-tray-exit.py` 每次重新核对唯一独立 exe PID/path、fresh tray/popup、GetGUIThreadInfo 的 popup owner、菜单末项实际文字及 id；先用 WM_CANCELMODE 结束该真实菜单模态循环，再向该 owner 发回读的 WM_COMMAND。muda 正常菜单事件进入 `desktop::MENU_QUIT → backup::quit → app.exit(0) → RunEvent::Exit → desktop::on_exit`。没有私有退出 IPC、WM_QUIT 或强杀 app。句柄等待确认 old/new 进程都正常结束且退出码 0，随后才清理自己的 driver。

源码依据：本机 registry `tray-icon-0.25.1/src/platform_impl/windows/mod.rs` 的 `tray_proc`/`show_tray_menu`，`muda-0.20.0/src/platform_impl/windows/mod.rs` 的 WM_COMMAND/handle_item_activate；产品 `src-tauri/src/desktop/mod.rs`、`backup.rs`、`lib.rs`。此方法只验证真实正常退出回调及持久保存，不声称进行了人工托盘点击。
