#!/usr/bin/env bash
# 一次跑完 #283 的验收（会在屏幕上弹出置顶钉图、启动最大化的测试用 Edge、动真实鼠标键盘；先确认没人在用电脑）。
# 用法：scripts/run-all.sh <输出目录> [起始阶段 selftest|memory|edge|input]。报告只含数字，不截屏。
set -u
OUT=${1:?输出目录}
FROM=${2:-selftest}
stage() { case "$FROM" in selftest) return 0;; memory) [ "$1" != selftest ];; edge) [ "$1" = edge ] || [ "$1" = input ];; input) [ "$1" = input ];; esac; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN="$HERE/target/release/kinshoko-pin-frame-check.exe"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT=9339
mkdir -p "$OUT"

if stage selftest; then
echo "== 自测：两槽换窗（逐帧核对）×2"
"$BIN" --selftest "$OUT/swap-1.txt" --verify > /dev/null; echo "第 1 轮退出码 $?"
"$BIN" --selftest "$OUT/swap-2.txt" --verify > /dev/null; echo "第 2 轮退出码 $?"
echo "== 对照组：一个槽，先改窗口再 Present／反过来（应当抓到错位）"
"$BIN" --selftest "$OUT/naive-move-first.txt" --verify --naive > /dev/null
"$BIN" --selftest "$OUT/naive-present-first.txt" --verify --naive --present-first > /dev/null
echo "== 设备丢失后重建、窗口区域裁输入的实验"
"$BIN" --device-loss > "$OUT/device-loss.txt" 2>&1
"$BIN" --region-test > "$OUT/region.txt" 2>&1
fi

if stage memory; then
echo "== 内存、显存与 QUNS"
for n in 1 5 10; do
  echo "-- $n 张" >> "$OUT/memory.txt"
  "$BIN" --hold 500 --count $n >> "$OUT/memory.txt"
done
echo "-- 1 张盖满屏幕" >> "$OUT/memory.txt"
"$BIN" --hold 500 --fill >> "$OUT/memory.txt"
fi

if stage edge; then
echo "== 背后最大化的 Edge"
PROFILE=$(mktemp -d)
PAGE='data:text/html,<body style="margin:0"><div id=b style="width:200px;height:200px;background:%23c33;position:absolute"></div><script>let t=0;function f(){t++;b.style.left=(t%25600)/10+"px";requestAnimationFrame(f)}f()</script></body>'
"$EDGE" --user-data-dir="$PROFILE" --remote-debugging-port=$PORT --start-maximized --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-features=msImplicitSignin,msEdgeSyncConsent "$PAGE" > /dev/null 2>&1 &
sleep 8
# 把测试用 Edge 放到前台（别的窗口在前台时它被判为被遮挡，下面的数就没意义）。
powershell -NoProfile -Command "\$p = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*$(basename "$PROFILE")*' -and \$_.CommandLine -notlike '*--type=*' } | Select-Object -First 1; (New-Object -ComObject WScript.Shell).AppActivate([int]\$p.ProcessId) | Out-Null"
sleep 2
edge() { node "$HERE/scripts/edge-frames.mjs" $PORT "$1" >> "$OUT/edge.txt"; pwsh -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HERE/scripts/foreground.ps1")" -Profile "$(basename "$PROFILE")" >> "$OUT/edge.txt"; }
# 工具放后台跑，只等它自己（不带参数的 wait 会连 Edge 一起等）。
probe() { echo "-- $*" >> "$OUT/edge-probe.txt"; "$BIN" "$@" >> "$OUT/edge-probe.txt" & P=$!; }
edge "没有钉图"
probe --hold 4000; sleep 1.5; edge "一张钉图"; wait $P
probe --hold 4000 --count 8; sleep 3; edge "八张钉图"; wait $P
probe --hold 4000 --fill; sleep 1.5; edge "盖满屏幕（让出一行）"; wait $P
"$BIN" --selftest "$OUT/edge-selftest.txt" > /dev/null & P=$!; sleep 1; edge "自测进行中（缩放、换窗）"; sleep 1; edge "自测进行中 2"; wait $P
# 只关这次用独立配置目录启动的 Edge，不碰别的 Edge。
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*$(basename "$PROFILE")*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
rm -rf "$PROFILE"
fi

if stage input; then
echo "== 真实输入与焦点（前台为收键窗口）"
"$BIN" --input-test --scale 0.12 > "$OUT/input.txt" 2>&1; echo "退出码 $?"
fi
echo "完成：$OUT"
