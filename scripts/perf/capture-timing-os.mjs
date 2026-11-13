import { spawnSync } from "node:child_process";
import { basename } from "node:path";

// 测试里的 Windows 辅助操作（按全局快捷键、窗口置顶、右键），原样从 capture-timing.mjs 移出。
export function createOsHelpers(python, application) {
// 开发机上常驻的已安装 Kinshoko 占着 F1：测试实例把框选改绑到不冲突的组合键，之后走同一条
// 全局快捷键 → on_shortcut → capture::start 路径。绝不按 F1，免得触发画师自己的实例。
const HOTKEY = "Ctrl+Shift+F9";
/** 真实按键：光标放到参考图中央（决定冻结哪台显示器），再经 keybd_event 按 HOTKEY。返回按下时刻（epoch ms）。 */
function pressHotkey(x, y) {
  const run = spawnSync(python, ["-I", "-c", `
import ctypes, sys, time
u = ctypes.windll.user32
u.SetCursorPos(int(sys.argv[1]), int(sys.argv[2]))
time.sleep(0.05)
u.keybd_event(0x11, 0, 0, 0)
u.keybd_event(0x10, 0, 0, 0)
t = time.time() * 1000
u.keybd_event(0x78, 0, 0, 0)
u.keybd_event(0x78, 0, 2, 0)
u.keybd_event(0x10, 0, 2, 0)
u.keybd_event(0x11, 0, 2, 0)
print(f"{t:.1f}")
`, String(x), String(y)], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr);
  return Number(run.stdout.trim());
}
/** 只把本次测试 exe 的主窗口（标题 Kinshoko）置顶；不碰其他进程的窗口。 */
function topmost() {
  const run = spawnSync(python, ["-I", "-c", `
import ctypes, ctypes.wintypes as w, sys
u = ctypes.windll.user32; k = ctypes.windll.kernel32
found = []
def cb(h, _):
    pid = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    hp = k.OpenProcess(0x1000, False, pid.value)
    if not hp: return True
    buf = ctypes.create_unicode_buffer(1024); n = w.DWORD(1024)
    ok = k.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)); k.CloseHandle(hp)
    t = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, t, 256)
    if ok and buf.value.lower().endswith(sys.argv[1].lower()) and t.value == "Kinshoko" and u.IsWindowVisible(h):
        found.append(h)
    return True
u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)(cb), 0)
for h in found: u.SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
print(len(found))
`, basename(application)], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0 || run.stdout.trim() !== "1") throw new Error(`无法置顶测试主窗口：${run.stderr || run.stdout}`);
}
/** 在 (x, y) 右键：框选窗口置顶铺满显示器，右键即取消，不依赖它拿到键盘焦点。只在已显示后调用。 */
function rightClick(x, y) {
  const run = spawnSync(python, ["-I", "-c", "import ctypes,sys; u=ctypes.windll.user32; u.SetCursorPos(int(sys.argv[1]),int(sys.argv[2])); u.mouse_event(8,0,0,0,0); u.mouse_event(16,0,0,0,0)", String(x), String(y)], { windowsHide: true });
  if (run.status !== 0) throw new Error("右键失败");
}
  return { HOTKEY, pressHotkey, topmost, rightClick };
}
