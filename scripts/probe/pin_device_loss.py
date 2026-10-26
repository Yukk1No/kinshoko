"""GPU 设备丢失后钉图重新显示（#277“设备丢失能重建”、#287）。

应用带测试钩子 `KINSHOKO_PIN_LOSE_DEVICE_MS` 启动：第一次建好 GPU 设备后过这么久销毁它（与驱动重启、
远程桌面切换时一样，之后每次 GPU 调用都失败）。剪贴板钉图（F3）钉一张测试图，等设备丢失，再看：

- 运行日志记下“原生钉图 GPU 设备丢失”与“设备丢失后重新显示 N ms”，N < 1000；
- 之后屏幕上的钉图与测试图逐像素一致、位置不变（桌面复制截屏，只截钉图那一块）；
- 之后滚轮还能缩放，进程没有退出。

用法：python scripts/probe/pin_device_loss.py target/release/kinshoko.exe
截屏要先在 tools/pin-frame-check 里 `cargo build --release`。运行期间会移动鼠标、按 F3，请不要碰键鼠；
不能有别的 Kinshoko 或占用 F3 的程序在运行。数据放在临时目录。
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture_pin import PIN_TITLE, diff, grab, key, move, pause, pin_content, probe_data, running, started, wait_for  # noqa: E402
from pin_backdrop import VK_F3, put_png, test_image, wheel, windows  # noqa: E402

LOSE_AFTER_MS = 4000


def log_lines(data):
    lines = []
    for f in sorted((data / "logs").glob("run-*.jsonl")):
        lines += [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line.strip()]
    return lines


def mentions(lines, text):
    return [line for line in lines if text in json.dumps(line, ensure_ascii=False)]


def main():
    exe = Path(sys.argv[1]).resolve()
    if running(exe.name):
        raise SystemExit("已有 Kinshoko 在运行（单实例，且占着 F3），先退出它")
    data = probe_data()
    # 运行日志测试版默认开着；这里写明，免得版本号变了以后默认关。
    (data / "settings.json").write_text(json.dumps({"runLog": True}), encoding="utf-8")
    env = dict(os.environ, KINSHOKO_DATA_DIR=str(data), KINSHOKO_SKIP_AUTOSTART="1",
               KINSHOKO_PIN_LOSE_DEVICE_MS=str(LOSE_AFTER_MS))
    app = subprocess.Popen([str(exe), "--autostart"], env=env)
    image = test_image()
    results = {}
    try:
        wait_for("应用启动", lambda: started(app.pid), timeout=20)
        pause(1.5)
        put_png(image)
        move(1200, 700)
        key(VK_F3)
        t0 = time.time()
        before = wait_for("钉图", lambda: pin_content(app.pid))
        move(0, 0)
        pause(1.5)
        results["丢失前钉图与测试图一致"] = diff(grab(before), image)
        wait_for("设备丢失", lambda: mentions(log_lines(data), "GPU 设备丢失"), timeout=LOSE_AFTER_MS / 1000 + 5)
        lost_at = time.time() - t0
        shown = wait_for("重新显示", lambda: mentions(log_lines(data), "设备丢失后重新显示"), timeout=5)
        detail = json.dumps(shown[0], ensure_ascii=False)
        ms = int(detail.split("重新显示")[1].split(" ms")[0].split('"')[-1].strip("：: "))
        results[f"设备丢失后 {ms} ms 重新显示（要 < 1000）"] = None if ms < 1000 else f"{ms} ms"
        pause(1.0)
        after = pin_content(app.pid)
        results["位置不变"] = None if after == before else f"{before} → {after}"
        results["丢失后钉图与测试图一致"] = diff(grab(after), image) if after else "看不见钉图"
        wheel(((after[0] + after[2]) // 2, (after[1] + after[3]) // 2), 2)
        pause(1.5)
        zoomed = pin_content(app.pid)
        results["之后滚轮还能缩放"] = (None if zoomed and zoomed[2] - zoomed[0] > after[2] - after[0]
                                       else f"{after} → {zoomed}")
        results["进程还在"] = None if app.poll() is None else f"退出码 {app.returncode}"
        results["只有一张钉图"] = None if len(windows(app.pid, PIN_TITLE)) == 1 else "钉图窗口数不对"
        print(f"钉图后约 {lost_at:.1f} 秒设备丢失")
    finally:
        app.kill()

    failed = 0
    for name, problem in results.items():
        print(("✗ " if problem else "✓ ") + name + (f"：{problem}" if problem else ""))
        failed += bool(problem)
    print(f"数据目录 {data}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
