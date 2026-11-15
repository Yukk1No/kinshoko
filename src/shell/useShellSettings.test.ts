// 应用壳设置（#321）：标签外观草稿跨恢复时怎样叠在已接受的设置上。
import { describe, expect, it } from "vitest";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { TagDisplay } from "../bindings/TagDisplay";
import { backend, defaults } from "../settings/SettingsPanel.fixtures";
import { createShellSettings } from "./useShellSettings";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("标签外观草稿", () => {
  it("恢复之前的外观保存失败，只清掉那一段的草稿；恢复之后排着的改动照样显示并写入", async () => {
    const backup: ShellSettingsView = { ...defaults, tagDisplay: { style: "bands", high: 0.9, low: 0.2 } };
    const replies: Record<string, (() => void)[]> = { tag: [], restore: [] };
    const sent: TagDisplay[] = [];
    let failNextTag = true;
    backend({
      "change_setting:tagDisplay": (args) => {
        const display = (args as { display: TagDisplay }).display;
        sent.push(display);
        const fail = failNextTag;
        failNextTag = false;
        return new Promise((resolve, reject) =>
          replies.tag.push(() => (fail ? reject("无法写入设置文件") : resolve({ ...backup, tagDisplay: display }))),
        );
      },
      restore_application_settings: () =>
        new Promise((resolve) =>
          replies.restore.push(() => resolve({ settings: backup, safeMode: true, problems: [] })),
        ),
    });
    const settings = createShellSettings();
    await settings.load();
    settings.changeTagDisplay({ high: 0.85 });
    const restored = settings.restore("C:/backup/a.kinshoko-settings", "fixed-backup");
    settings.changeTagDisplay({ style: "grouped" });
    expect(settings.state().tagDraft?.style).toBe("grouped");
    await tick();
    replies.tag.shift()!();
    await tick();
    expect(settings.state().tagDraft?.style).toBe("grouped");
    replies.restore.shift()!();
    await restored;
    await tick();
    expect(settings.state().tagDraft).toEqual({ style: "grouped", high: 0.9, low: 0.2 });
    replies.tag.shift()!();
    await tick();
    expect(sent.at(-1)).toEqual({ style: "grouped", high: 0.9, low: 0.2 });
    expect(settings.state().tagDraft).toBeNull();
    expect(settings.state().view?.tagDisplay).toEqual({ style: "grouped", high: 0.9, low: 0.2 });
  });
});
