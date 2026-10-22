"""钉图滚轮缩放的录屏检查（#209，#193 的抽搐与闪烁）。

钉一张渐变测试图（R 编码图片 x、G 编码图片 y、B 固定 40）在品红背景上，把光标放在图片
三分之一处发滚轮：慢放 4 格、慢缩 4 格、快放 5 格、快缩 5 格。ffmpeg 的 ddagrab 按显示器
刷新率录下背景区域，逐个不同的帧判定：

- 抽搐（DRIFT）：光标下的图片坐标比第一帧漂移超过 6（缩放应以光标为中心）；
- 裁切（CLIP）：渐变外框的四条边不是 R≈0、R≈255、G≈0、G≈255，图片被切掉了一块；
- 空洞（HOLE）：外框内出现品红背景；
- 空帧（EMPTY）：录到的区域里没有图片。

输出问题帧数与汇总，没有问题帧时退出码为 0。#193 修复前（#203 合并前）的构建约有 22 个
问题帧，修复后为 0。

用法：
    python scripts/probe/pin_zoom.py target/release/kinshoko.exe
    python scripts/probe/pin_zoom.py --analyse <录像目录>   # 只重新分析已有的录像，不碰键鼠

exe 必须是探针构建（见 guard.py：`npx tauri build --no-bundle --config scripts/probe/tauri.probe.json`），
可以与已安装、正在运行的 Kinshoko 同时存在。需要 Pillow、numpy 和 PATH 里的 ffmpeg/ffprobe；
有 NVIDIA 显卡时用 h264_nvenc 无损编码，否则用 libx264rgb。录屏取主显示器（DXGI 输出 0）。
运行期间会移动鼠标、发滚轮、按 F14，并改写剪贴板，请不要碰键鼠。原始录像只留在打印出的
临时目录里，不要放进仓库或上传。
"""

import ctypes
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from guard import VK_PIN_CLIPBOARD, check_foreground, data_dir, launch, take_input, user32  # noqa: E402

GRADIENT = (512, 384)
BLUE = 40
MAGENTA = "#ff00ff"
WHEEL = 0x0800
# 判定阈值（#193 实测校准）：边缘跳过最外一圈重新采样的像素后允许的偏差、漂移与空洞像素数。
EDGE_TOL, DRIFT_TOL, HOLE_TOL = 14, 6, 20
# 滚轮序列：（名称，格数，方向，每格间隔秒数），每段之后停一会儿让动画走完。
SEQUENCE = [("慢放", 4, 1, 0.6), ("慢缩", 4, -1, 0.6), ("快放", 5, 1, 0.05), ("快缩", 5, -1, 0.05)]


def key(vk):
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.03)
    user32.keybd_event(vk, 0, 0x0002, 0)


def gradient():
    w, h = GRADIENT
    img = np.zeros((h, w, 3), np.uint8)
    img[:, :, 0] = np.linspace(0, 255, w).astype(np.uint8)[None, :]
    img[:, :, 1] = np.linspace(0, 255, h).astype(np.uint8)[:, None]
    img[:, :, 2] = BLUE
    return Image.fromarray(img)


def set_clipboard(png):
    subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command",
         "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
         f"[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('{png}'))"],
        check=True,
    )


def refresh_rate():
    hdc = user32.GetDC(0)
    hz = ctypes.windll.gdi32.GetDeviceCaps(hdc, 116)  # VREFRESH
    user32.ReleaseDC(0, hdc)
    return hz if hz > 1 else 60


def capture_region():
    """主显示器中间一块（物理像素 x, y, w, h），放大 4 格后的钉图仍在里面。"""
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    w, h = min(1600, sw - 200), min(1100, sh - 200)
    return ((sw - w) // 2 // 2 * 2, (sh - h) // 2 // 2 * 2, w // 2 * 2, h // 2 * 2)


class Backdrop:
    """品红背景：置顶、无边框，在自己的线程里处理消息。"""

    def __init__(self, region):
        self.region, self.closed = region, threading.Event()
        threading.Thread(target=self.run, daemon=True).start()
        time.sleep(1.0)

    def run(self):
        x, y, w, h = self.region
        root = tk.Tk()
        root.overrideredirect(True)
        root.geometry(f"{w}x{h}+{x}+{y}")
        root.configure(bg=MAGENTA)
        root.attributes("-topmost", True)

        def poll():
            if self.closed.is_set():
                root.destroy()
            else:
                root.after(50, poll)

        root.after(50, poll)
        root.mainloop()

    def close(self):
        self.closed.set()


def gradient_mask(frame):
    r, g, b = frame[..., 0], frame[..., 1], frame[..., 2]
    magenta = (r > 200) & (g < 70) & (b > 200)
    return (np.abs(b - BLUE) < 12) & ~magenta, magenta


def bbox(mask):
    # 忽略零星噪点：行、列里要有一段渐变像素。
    cols = np.nonzero(mask.sum(axis=0) > 8)[0]
    rows = np.nonzero(mask.sum(axis=1) > 8)[0]
    if len(cols) == 0 or len(rows) == 0:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def grab_region(region):
    from PIL import ImageGrab

    x, y, w, h = region
    return np.asarray(ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).convert("RGB")).astype(np.int16)


def record(exe, out):
    region = capture_region()
    png = out / "gradient.png"
    gradient().save(png)
    set_clipboard(png)
    backdrop = Backdrop(region)
    app = launch(exe, data_dir({"safeMode": False}, out / "data"))
    ff = None
    try:
        user32.SetCursorPos(region[0] + 500, region[1] + 400)
        key(VK_PIN_CLIPBOARD)
        content = None
        end = time.time() + 10
        while time.time() < end and content is None:
            time.sleep(0.2)
            content = bbox(gradient_mask(grab_region(region))[0])
        if content is None:
            raise SystemExit("等待超时：钉图没有出现在品红背景上")
        time.sleep(1.5)  # 等出现时的描边淡出
        x0, y0, x1, y1 = bbox(gradient_mask(grab_region(region))[0])
        anchor = (x0 + (x1 - x0) // 3, y0 + (y1 - y0) // 3)
        user32.SetCursorPos(region[0] + anchor[0], region[1] + anchor[1])
        time.sleep(0.5)

        x, y, w, h = region
        hz = refresh_rate()
        grab = f"ddagrab=output_idx=0:draw_mouse=0:framerate={hz}:offset_x={x}:offset_y={y}:video_size={w}x{h}"
        encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        if "h264_nvenc" in encoders:
            codec = ["-c:v", "h264_nvenc", "-qp", "0", "-preset", "p1"]
        else:
            codec = ["-vf", "hwdownload,format=bgra", "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast"]
        ff = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", grab, *codec,
             str(out / "cap.mkv")],
            stdin=subprocess.PIPE,
        )
        time.sleep(1.0)
        for name, notches, sign, gap in SEQUENCE:
            # 录像中途换了前台（例如游戏弹出）就停下，不再注入输入。
            check_foreground(ignore=(app.pid,))
            for _ in range(notches):
                user32.mouse_event(WHEEL, 0, 0, 120 * sign, 0)
                time.sleep(gap)
            time.sleep(1.0)
        ff.communicate(b"q", timeout=30)
        ff = None
    finally:
        if ff:
            ff.kill()
        backdrop.close()
        app.kill()
    (out / "run.json").write_text(json.dumps({"anchor": anchor, "region": region, "hz": hz}), "utf-8")


def frames(video):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE)
    size = w * h * 3
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.int16)
    p.wait()


def judge(frame, anchor):
    """一帧的外框、四边取值、光标下的颜色和问题列表（不含漂移，漂移要和第一帧比）。"""
    mask, magenta = gradient_mask(frame)
    box = bbox(mask)
    if box is None:
        return {"bbox": None, "flags": ["EMPTY"]}
    x0, y0, x1, y1 = box
    my, mx = (y0 + y1) // 2, (x0 + x1) // 2
    # 向内跳 2 像素，避开重新采样过的最外一圈。
    left, right = int(frame[my, x0 + 2, 0]), int(frame[my, x1 - 3, 0])
    top, bottom = int(frame[y0 + 2, mx, 1]), int(frame[y1 - 3, mx, 1])
    flags = []
    if left > EDGE_TOL or right < 255 - EDGE_TOL or top > EDGE_TOL or bottom < 255 - EDGE_TOL:
        flags.append(f"CLIP L{left} R{right} T{top} B{bottom}")
    hole = int(magenta[y0 + 2:y1 - 2, x0 + 2:x1 - 2].sum())
    if hole > HOLE_TOL:
        flags.append(f"HOLE {hole}")
    ax, ay = anchor
    return {"bbox": box, "anchor": [int(frame[ay, ax, 0]), int(frame[ay, ax, 1])], "flags": flags}


def analyse(out):
    anchor = json.loads((out / "run.json").read_text("utf-8"))["anchor"]
    rows, prev, total, base = [], None, 0, None
    for i, frame in enumerate(frames(out / "cap.mkv"), 1):
        total = i
        if prev is not None and np.array_equal(frame, prev):
            continue
        prev = frame
        row = {"frame": i, **judge(frame, anchor)}
        if "anchor" in row:
            base = base or row["anchor"]
            drift = max(abs(row["anchor"][0] - base[0]), abs(row["anchor"][1] - base[1]))
            if drift > DRIFT_TOL:
                row["flags"].append(f"DRIFT {drift}")
        rows.append(row)
    (out / "frames.json").write_text(json.dumps(rows), "utf-8")

    bad = [r for r in rows if r["flags"]]
    kinds = {}
    for r in bad:
        for flag in r["flags"]:
            kinds[flag.split()[0]] = kinds.get(flag.split()[0], 0) + 1
    print(f"录像 {total} 帧，其中 {len(rows)} 个不同帧；第一帧外框 {rows[0]['bbox'] if rows else None}")
    for r in bad[:40]:
        print(f"  第 {r['frame']} 帧 外框 {r['bbox']} 光标下 {r.get('anchor')}：{'；'.join(r['flags'])}")
    if len(bad) > 40:
        print(f"  ……另有 {len(bad) - 40} 个问题帧，见 frames.json")
    summary = "、".join(f"{k} {n}" for k, n in sorted(kinds.items())) or "无"
    print(f"问题帧 {len(bad)} 个（{summary}）")
    print(("✓ " if not bad else "✗ ") + "钉图滚轮缩放没有抽搐、裁切与空洞")
    print(f"录像与逐帧结果（只留本机）：{out}")
    return not bad


def main():
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("PATH 里没有 ffmpeg/ffprobe")
    if sys.argv[1:2] == ["--analyse"]:
        sys.exit(0 if analyse(Path(sys.argv[2])) else 1)
    exe = Path(sys.argv[1]).resolve()
    out = Path(tempfile.mkdtemp(prefix="kinshoko-pin-zoom-"))
    with take_input("pin_zoom.py"):
        record(exe, out)
    sys.exit(0 if analyse(out) else 1)


if __name__ == "__main__":
    main()
