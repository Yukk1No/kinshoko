// 一次 F1 的各阶段计时，原样从 capture-timing.mjs 移出；依赖由主脚本传入。
export function createCapture({ pressHotkey, windows, until, native, desktop, invoke, sleep, marks, after, first, round }) {
/** 一次 F1：按键 → 显示，再在参考图内完成 action。返回各阶段相对按键的毫秒数。 */
async function capture(shown, action) {
  const before = await windows();
  const pressed = pressHotkey(shown.x + Math.floor(shown.width / 2), shown.y + Math.floor(shown.height / 2));
  const visible = await until("框选窗口已显示", async () => (await windows()).includes("capture") && (await native("is_visible", "capture")), 30000, 10);
  const seenVisible = Date.now();
  const origin = await native("inner_position", "capture");
  const region = { x: shown.x + Math.floor(shown.width / 4) - origin.x, y: shown.y + Math.floor(shown.height / 4) - origin.y, width: Math.max(4, Math.floor(shown.width / 8)), height: Math.max(4, Math.floor(shown.height / 8)) };
  const frozen = await desktop("frozen_screen");
  const readout = await desktop("capture_readout", { region, token: frozen.image.slice("screen/".length) });
  const confirmed = Date.now();
  await desktop("finish_capture", { region, action, token: frozen.image.slice("screen/".length) });
  let pinShown = null;
  if (action === "pin") {
    const label = await until("新钉图", async () => (await windows()).find((l) => l.startsWith("pin-") && !before.includes(l)), 30000, 10);
    await until("钉图已显示", () => native("is_visible", label), 30000, 10);
    pinShown = Date.now();
    // 钉图留着会盖住下一次的选区（走普通截图）：关掉它，并确认已关闭。
    await invoke("plugin:window|close", { label });
    await until("钉图已关闭", async () => !(await windows()).includes(label));
  }
  // 修复前框选窗口用完即销毁，修复后（#129）只隐藏：两种都算结束。
  await until("框选窗口已关闭", async () => !(await windows()).includes("capture") || !(await native("is_visible", "capture")));
  await sleep(300);
  const m = after(marks(), pressed - 5);
  const at = (name) => first(m, name)?.at;
  const rel = (t) => round(t - pressed);
  const finish = at("finish.begin");
  const stages = {
    keyToStart: rel(at("start")), grabbed: rel(at("grabbed")),
    windowBuilt: rel(at("window.built")), pageAsksFrozen: rel(at("frozen_screen")),
    pngBegin: rel(at("png.begin")), pngEnd: rel(at("png.end")),
    shown: rel(at("shown")), harnessSawVisible: rel(seenVisible),
    pngBytes: Number(/bytes=(\d+)/.exec(first(m, "png.end")?.detail ?? "")?.[1] ?? 0),
    references: Number(/references=(\d+)/.exec(first(m, "frozen")?.detail ?? "")?.[1] ?? -1),
    covered: Number(/covered=(\d+)/.exec(first(m, "frozen")?.detail ?? "")?.[1] ?? -1),
  };
  const result = {
    original: readout,
    confirmToFinishBegin: round(finish - confirmed),
    prepare: round(at("finish.prepared") - finish),
    finishEnd: round(at("finish.end") - finish),
    pinWindowBegin: round(at("pin.window.begin") - finish),
    pinReady: round(at("pin.ready") - finish),
    harnessPinShown: pinShown ? round(pinShown - confirmed) : null,
  };
  return { action, stages, result, visible: !!visible };
}
  return capture;
}
