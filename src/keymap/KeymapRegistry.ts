/** 页面内快捷键注册表：声明、匹配、输入框与 IME 守卫都在这里。 */

export type KeymapScope = "main" | "wall" | "viewer" | "subscriptionSearch";
export type KeymapSettingsGroup = "main" | "viewer";
export type EditableKeyPolicy = "ignore" | "allow";
type ModifierRule = boolean | "any";

/**
 * 一个键盘按键组合。`key` 用 `KeyboardEvent.key`；单个字母不分大小写。
 * `mod` 是 Ctrl 或 Meta；`mod` 与 `alt` 默认必须没有按下，`shift` 默认不限制（大写字母仍算同一个键）。
 * 明确写 `true` 时要求按下，写 `"any"` 时不检查。
 */
export type KeyBinding = {
  kind: "key";
  key: string;
  mod?: ModifierRule;
  alt?: ModifierRule;
  shift?: ModifierRule;
  /** 覆盖条目在输入控件里的策略；默认跟随条目，条目默认 ignore。 */
  editable?: EditableKeyPolicy;
  /** 键帽写法与按键名不同时的显示，例如 ArrowLeft 显示为 ←。 */
  display?: string;
};

/** 设置页也要列出的非键盘操作（滚轮、拖动）。它不参与按键匹配。 */
export type GestureBinding = {
  kind: "gesture";
  textKey: string;
};

export type KeymapBinding = KeyBinding | GestureBinding;

export type KeymapEntry<Action extends string = string> = {
  scope: KeymapScope;
  action: Action;
  labelKey: string;
  bindings: readonly KeymapBinding[];
  editable?: EditableKeyPolicy;
  ignoreRepeat?: boolean;
  settings?: {
    group: KeymapSettingsGroup;
    hintKey?: string;
  };
};

/** 输入法正在处理这次按键。keyCode 229 覆盖结束选字那一下 isComposing 已经复位的情况。 */
export function isImeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * 按键落在会输入或消费编辑按键的控件里：input、textarea、select 或 contenteditable。
 * contenteditable 取最近的一层声明，嵌套的 false 不会被外层 true 误认。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  const host = target.closest("[contenteditable]");
  return host !== null && host.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

const modifierMatches = (rule: ModifierRule | undefined, fallback: ModifierRule, actual: boolean) => {
  const effective = rule ?? fallback;
  return effective === "any" || effective === actual;
};

const sameKey = (wanted: string, actual: string) =>
  wanted.length === 1 && actual.length === 1 ? wanted.toLowerCase() === actual.toLowerCase() : wanted === actual;

function keyBindingMatches(binding: KeyBinding, event: KeyboardEvent): boolean {
  if (!sameKey(binding.key, event.key)) return false;
  if (!modifierMatches(binding.mod, false, event.ctrlKey || event.metaKey)) return false;
  if (!modifierMatches(binding.alt, false, event.altKey)) return false;
  return modifierMatches(binding.shift, "any", event.shiftKey);
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Delete: "Del",
  " ": "Space",
};

function keyName(key: string): string {
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 键帽上显示的默认写法；Windows 页面里 `mod` 显示为 Ctrl。 */
export function formatKeyBinding(binding: KeyBinding): string {
  if (binding.display) return binding.display;
  const parts: string[] = [];
  if (binding.mod === true) parts.push("Ctrl");
  if (binding.alt === true) parts.push("Alt");
  if (binding.shift === true) parts.push("Shift");
  parts.push(keyName(binding.key));
  return parts.join("+");
}

/** 设置页一项的键帽文字；手势条目的文字键交给调用方按当前界面语言翻译。 */
export function keymapEntryText<Action extends string>(
  entry: KeymapEntry<Action>,
  translate: (key: string) => string,
): string {
  const binding = entry.bindings[0];
  return binding.kind === "gesture" ? translate(binding.textKey) : formatKeyBinding(binding);
}

/**
 * 声明式按键表。调用方只问“某个动作是否命中”或“这个作用域命中了什么”，
 * 不各自解释修饰键、输入控件、IME 组合态与重复按键。
 */
export class KeymapRegistry<Action extends string = string> {
  private readonly byAction: ReadonlyMap<Action, KeymapEntry<Action>>;

  constructor(readonly entries: readonly KeymapEntry<Action>[]) {
    const seen = new Set<Action>();
    for (const entry of entries) {
      if (seen.has(entry.action)) throw new Error(`Duplicate keymap action: ${entry.action}`);
      if (entry.bindings.length === 0) throw new Error(`Keymap action has no binding: ${entry.action}`);
      seen.add(entry.action);
    }
    this.byAction = new Map(entries.map((entry) => [entry.action, entry]));
  }

  /** 这次按键是否命中某个动作。已经消耗、IME 组合态、repeat 与输入控件守卫都在这里判断。 */
  matches(action: Action, event: KeyboardEvent): boolean {
    const entry = this.byAction.get(action);
    return entry !== undefined && this.entryMatches(entry, event);
  }

  /** 这次按键在某个作用域命中的第一个条目；没有命中为 null。 */
  match(event: KeyboardEvent, scope: KeymapScope): KeymapEntry<Action> | null {
    for (const entry of this.entries) {
      if (entry.scope === scope && this.entryMatches(entry, event)) return entry;
    }
    return null;
  }

  /** 设置页某个分组要列出的条目，顺序就是声明顺序。 */
  settingsEntries(group: KeymapSettingsGroup): KeymapEntry<Action>[] {
    return this.entries.filter((entry) => entry.settings?.group === group);
  }

  private entryMatches(entry: KeymapEntry<Action>, event: KeyboardEvent): boolean {
    if (event.defaultPrevented || isImeComposing(event) || (entry.ignoreRepeat && event.repeat)) return false;
    for (const binding of entry.bindings) {
      if (binding.kind !== "key" || !keyBindingMatches(binding, event)) continue;
      const editable = binding.editable ?? entry.editable ?? "ignore";
      if (editable === "allow" || !isEditableTarget(event.target)) return true;
    }
    return false;
  }
}
