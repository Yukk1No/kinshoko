// 程序设置的提交模型（#321）：写入次序、合并、失败与整份替换交错时接受哪份快照。
import { describe, expect, it } from "vitest";
import { createSettingsSubmitter, type SettingsCommand } from "./settingsSubmitter";

type View = { autostart: boolean; style: string; outline: boolean; keys: string[] };

/** 像核心一样：收到命令才改设置，回整份快照；回复要等测试放行，放行时也可以让它失败。 */
function fakeCore() {
  let saved: View = { autostart: true, style: "bands", outline: true, keys: [] };
  const started: string[] = [];
  const waiting: { label: string; reply: (fail?: string) => void }[] = [];
  const send = (label: string, change: (view: View) => View) => () => {
    started.push(label);
    return new Promise<View>((resolve, reject) => {
      waiting.push({
        label,
        reply: (fail) => {
          if (fail) return reject(fail);
          saved = change(saved);
          resolve(saved);
        },
      });
    });
  };
  /** 放行最早发出的那条，等回复和随后的下一条发出。 */
  const release = async (fail?: string) => {
    const next = waiting.shift();
    if (!next) throw new Error("没有等着回复的命令");
    next.reply(fail);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return next.label;
  };
  return { started, waiting, send, release, saved: () => saved };
}

function setup() {
  const core = fakeCore();
  const accepted: View[] = [];
  const submitter = createSettingsSubmitter<View>({ onAccepted: (view) => accepted.push(view) });
  const autostart = (on: boolean): SettingsCommand<View> =>
    ({ key: "autostart", merge: "latest", run: core.send(`autostart=${on}`, (v) => ({ ...v, autostart: on })) });
  const display = (style: string, outline: boolean): SettingsCommand<View> => ({
    key: "display", merge: "latest", dropPendingOnFailure: true,
    run: core.send(`display=${style}/${outline}`, (v) => ({ ...v, style, outline })),
  });
  const rebind = (key: string): SettingsCommand<View> =>
    ({ key: "shortcut", merge: "keep", run: core.send(`rebind=${key}`, (v) => ({ ...v, keys: [...v.keys, key] })) });
  const restore = (view: View): SettingsCommand<View> =>
    ({ key: "restore", merge: "keep", replaces: true, quiet: true, run: core.send("restore", () => view) });
  return { core, accepted, submitter, autostart, display, rebind, restore };
}

describe("设置提交模型", () => {
  it("一次只发一条：后提交的等前一条回来才发，回来的快照按提交顺序接受", async () => {
    const { core, accepted, submitter, autostart, display } = setup();
    const first = submitter.submit(autostart(false));
    const second = submitter.submit(display("grouped", true));
    expect(core.started).toEqual(["autostart=false"]);
    await core.release();
    expect(core.started).toEqual(["autostart=false", "display=grouped/true"]);
    await core.release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(accepted.map((v) => [v.autostart, v.style])).toEqual([[false, "bands"], [false, "grouped"]]);
    expect(submitter.state().view).toEqual(core.saved());
  });

  it("跨项同时改：后接受的快照带着先改的那项，不相互回滚", async () => {
    const { core, submitter, autostart, display } = setup();
    void submitter.submit(display("grouped", true));
    void submitter.submit(autostart(false));
    while (core.waiting.length > 0) await core.release();
    expect(submitter.state().view).toMatchObject({ autostart: false, style: "grouped" });
  });

  it("同项连改：没发出的只留最后一次，提交过的调用方都拿到它的结果", async () => {
    const { core, submitter, display } = setup();
    const a = submitter.submit(display("grouped", true));
    const b = submitter.submit(display("grouped", false));
    const c = submitter.submit(display("bands", false));
    while (core.waiting.length > 0) await core.release();
    expect(core.started).toEqual(["display=grouped/true", "display=bands/false"]);
    expect(await Promise.all([a, b, c])).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(submitter.state().view).toMatchObject({ style: "bands", outline: false });
  });

  it("不可合并的命令每条都执行，按提交顺序", async () => {
    const { core, submitter, rebind } = setup();
    void submitter.submit(rebind("F1"));
    void submitter.submit(rebind("F2"));
    void submitter.submit(rebind("F3"));
    while (core.waiting.length > 0) await core.release();
    expect(core.started).toEqual(["rebind=F1", "rebind=F2", "rebind=F3"]);
    expect(submitter.state().view?.keys).toEqual(["F1", "F2", "F3"]);
  });

  it("失败后快照不变、记下原因；再改成功时清除原因", async () => {
    const { core, accepted, submitter, autostart } = setup();
    void submitter.submit(autostart(true));
    await core.release();
    const failed = submitter.submit(autostart(false));
    await core.release("无法写入设置文件");
    expect(await failed).toEqual({ ok: false, reason: "无法写入设置文件" });
    expect(submitter.state().view?.autostart).toBe(true);
    expect(submitter.state().error).toBe("无法写入设置文件");
    expect(accepted).toHaveLength(1);
    void submitter.submit(autostart(false));
    await core.release();
    expect(submitter.state()).toMatchObject({ view: { autostart: false }, error: null });
  });

  it("标签外观失败时排着的同项改动一并作废，别项照常执行", async () => {
    const { core, submitter, autostart, display } = setup();
    const a = submitter.submit(display("grouped", true));
    const b = submitter.submit(display("grouped", false));
    const other = submitter.submit(autostart(false));
    await core.release("无法写入设置文件");
    expect(await a).toEqual({ ok: false, reason: "无法写入设置文件" });
    expect(await b).toEqual({ ok: false, reason: "无法写入设置文件" });
    expect(core.started).toEqual(["display=grouped/true", "autostart=false"]);
    await core.release();
    expect(await other).toEqual({ ok: true });
    expect(submitter.state().view).toMatchObject({ autostart: false, style: "bands", outline: true });
  });

  it("开关失败时排着的同项改动照常执行：它的值不依赖失败的那次", async () => {
    const { core, submitter, autostart } = setup();
    void submitter.submit(autostart(false));
    const later = submitter.submit(autostart(true));
    await core.release("拒绝访问");
    await core.release();
    expect(await later).toEqual({ ok: true });
    expect(core.started).toEqual(["autostart=false", "autostart=true"]);
  });

  it("恢复与旧保存交错：恢复前的保存先回来，恢复的结果不被回滚；之后的改动在恢复之上", async () => {
    const { core, submitter, autostart, display, restore } = setup();
    const backup: View = { autostart: true, style: "grouped", outline: false, keys: ["F9"] };
    void submitter.submit(autostart(false));
    const restored = submitter.submit(restore(backup));
    void submitter.submit(display("bands", false));
    expect(core.started).toEqual(["autostart=false"]);
    await core.release(); // 恢复前的保存回得晚，也只在恢复之前被接受。
    await core.release();
    expect(await restored).toEqual({ ok: true });
    expect(submitter.state().view).toEqual(backup);
    expect(submitter.state().generation).toBe(1);
    await core.release();
    expect(submitter.state().view).toEqual({ ...backup, style: "bands" });
  });

  it("合并不越过恢复：恢复前排着的改动不会被恢复后的改动挪到恢复之后", async () => {
    const { core, submitter, autostart, display, restore } = setup();
    const backup: View = { autostart: true, style: "grouped", outline: false, keys: [] };
    void submitter.submit(autostart(false));
    void submitter.submit(display("bands", true));
    void submitter.submit(restore(backup));
    void submitter.submit(display("bands", false));
    while (core.waiting.length > 0) await core.release();
    expect(core.started).toEqual(["autostart=false", "display=bands/true", "restore", "display=bands/false"]);
    expect(submitter.state().view).toEqual({ ...backup, style: "bands", outline: false });
  });

  it("恢复失败不进共享错误，快照与代次不变", async () => {
    const { core, submitter, restore } = setup();
    const result = submitter.submit(restore({ autostart: false, style: "grouped", outline: false, keys: [] }));
    await core.release("备份已经改过");
    expect(await result).toEqual({ ok: false, reason: "备份已经改过" });
    expect(submitter.state()).toEqual({ view: null, error: null, generation: 0 });
  });
});
