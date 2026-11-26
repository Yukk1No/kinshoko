import { describe, expect, it } from "vitest";
import { formatKeyBinding, isEditableTarget, KeymapRegistry, type KeymapEntry } from "./KeymapRegistry";
import { resources } from "../i18n/resources";
import { keymapRegistry } from "./registry";

function keyEvent(target: EventTarget | null, init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    repeat: false,
    ...init,
    target,
  } as KeyboardEvent;
}

const pasteEvent = (target: EventTarget | null, init: Partial<KeyboardEvent> = {}) =>
  keyEvent(target, { key: "v", ctrlKey: true, ...init });

describe("KeymapRegistry 输入控件守卫", () => {
  it("input、textarea、select 与 contenteditable 里的 Ctrl+V 不命中图片墙导入", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const rich = document.createElement("div");
    rich.setAttribute("contenteditable", "true");

    for (const target of [input, textarea, select, rich]) {
      expect(isEditableTarget(target)).toBe(true);
      expect(keymapRegistry.matches("wall.paste", pasteEvent(target))).toBe(false);
    }
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(keymapRegistry.matches("wall.paste", pasteEvent(document.createElement("button")))).toBe(true);
  });

  it("contenteditable 嵌套的 false 区域不算可编辑，plaintext-only 算可编辑", () => {
    const outer = document.createElement("div");
    const off = document.createElement("div");
    const text = document.createElement("span");
    outer.setAttribute("contenteditable", "true");
    off.setAttribute("contenteditable", "false");
    off.append(text);
    outer.append(off);
    expect(isEditableTarget(text)).toBe(false);

    const plain = document.createElement("div");
    plain.setAttribute("contenteditable", "plaintext-only");
    plain.append(text);
    expect(isEditableTarget(text)).toBe(true);
  });

  it("IME 组合态与 keyCode 229 下不拦截按键", () => {
    const target = document.createElement("div");
    expect(keymapRegistry.matches("wall.paste", pasteEvent(target, { isComposing: true }))).toBe(false);
    expect(keymapRegistry.matches("wall.paste", pasteEvent(target, { keyCode: 229 }))).toBe(false);
  });

  it("条目可声明允许在输入控件里使用；绑定也可以单独覆盖", () => {
    const input = document.createElement("input");
    expect(keymapRegistry.matches("main.safeMode", keyEvent(input, { key: "S", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(keymapRegistry.matches("subscriptionSearch.open", keyEvent(input, { key: "/" }))).toBe(false);
    expect(keymapRegistry.matches("subscriptionSearch.open", keyEvent(input, { key: "f", ctrlKey: true }))).toBe(true);
  });

  it("声明忽略 repeat 的动作不响应按住后的重复按键", () => {
    const target = document.createElement("div");
    expect(keymapRegistry.matches("main.toggleInspector", keyEvent(target, { key: "i", repeat: true }))).toBe(false);
    expect(keymapRegistry.matches("main.toggleInspector", keyEvent(target, { key: "i" }))).toBe(true);
  });
});

describe("KeymapRegistry 声明表", () => {
  it("主窗口缩放按键从同一张表匹配：Ctrl+=/Ctrl++、Ctrl+-、Ctrl+0", () => {
    const target = document.createElement("div");
    const mod = (key: string) => keyEvent(target, { key, ctrlKey: true });
    expect(keymapRegistry.matches("main.zoomIn", mod("="))).toBe(true);
    expect(keymapRegistry.matches("main.zoomIn", mod("+"))).toBe(true);
    expect(keymapRegistry.matches("main.zoomOut", mod("-"))).toBe(true);
    expect(keymapRegistry.matches("main.zoomReset", mod("0"))).toBe(true);
    expect(keymapRegistry.matches("main.zoomIn", keyEvent(target, { key: "=" }))).toBe(false);
    expect(keymapRegistry.matches("main.zoomIn", keyEvent(target, { key: "=", ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });

  it("按作用域返回命中的条目，手势条目不参与键盘匹配", () => {
    const target = document.createElement("div");
    expect(keymapRegistry.match(keyEvent(target, { key: "0" }), "viewer")?.action).toBe("viewer.fit");
    expect(keymapRegistry.match(keyEvent(target, { key: "0" }), "wall")).toBeNull();
  });

  it("设置页两组行来自声明表，顺序固定", () => {
    expect(keymapRegistry.settingsEntries("main").map((entry) => entry.action)).toEqual([
      "main.safeMode",
      "main.zoomIn",
      "main.zoomOut",
      "main.zoomReset",
      "main.toggleInspector",
    ]);
    expect(keymapRegistry.settingsEntries("viewer").map((entry) => entry.action)).toEqual([
      "viewer.zoom",
      "viewer.pan",
      "viewer.cropGesture",
      "viewer.cropMode",
      "viewer.previous",
      "viewer.next",
      "viewer.fit",
      "viewer.actual",
      "viewer.pin",
      "viewer.details",
      "viewer.back",
    ]);
  });

  it("查看器左右方向键只各命中自己的动作", () => {
    const target = document.createElement("div");
    const left = keyEvent(target, { key: "ArrowLeft" });
    const right = keyEvent(target, { key: "ArrowRight" });
    expect(keymapRegistry.matches("viewer.previous", left)).toBe(true);
    expect(keymapRegistry.matches("viewer.next", left)).toBe(false);
    expect(keymapRegistry.matches("viewer.previous", right)).toBe(false);
    expect(keymapRegistry.matches("viewer.next", right)).toBe(true);
  });

  it("键帽显示由按键定义生成", () => {
    const safeMode = keymapRegistry.settingsEntries("main")[0].bindings[0];
    const previous = keymapRegistry.settingsEntries("viewer")[4].bindings[0];
    expect(safeMode.kind).toBe("key");
    expect(previous.kind).toBe("key");
    if (safeMode.kind === "key") expect(formatKeyBinding(safeMode)).toBe("Ctrl+Shift+S");
    if (previous.kind === "key") expect(formatKeyBinding(previous)).toBe("←");
  });

  it("声明表引用的中文与英文文案键都存在", () => {
    const lookup = (language: "zh-CN" | "en", key: string): unknown => {
      const [namespace, path] = key.split(":");
      let node: unknown = (resources[language] as Record<string, unknown>)[namespace];
      for (const part of path.split(".")) node = (node as Record<string, unknown>)?.[part];
      return node;
    };
    const keys = keymapRegistry.entries.flatMap((entry) => [
      entry.labelKey,
      entry.settings?.hintKey,
      ...entry.bindings.map((binding) => (binding.kind === "gesture" ? binding.textKey : null)),
    ]);
    for (const key of keys.filter((key): key is string => typeof key === "string")) {
      expect(lookup("zh-CN", key), `zh-CN ${key}`).toEqual(expect.any(String));
      expect(lookup("en", key), `en ${key}`).toEqual(expect.any(String));
    }
  });

  it("注册表拒绝重复动作与空绑定", () => {
    const entry = {
      scope: "main",
      action: "x",
      labelKey: "x",
      bindings: [{ kind: "key", key: "x" }],
    } as const satisfies KeymapEntry<"x">;
    expect(() => new KeymapRegistry([entry, entry])).toThrow("Duplicate keymap action");
    expect(() => new KeymapRegistry([{ ...entry, bindings: [] }])).toThrow("no binding");
  });
});
