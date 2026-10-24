import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { InputHTMLAttributes, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { Languages, Plus } from "lucide-react";

/** 一个候选。`label` 通常用 `Highlight` 标出匹配的字；`create` 是放在最后的新建项。 */
export type ComboboxOption = {
  id: string;
  label: ReactNode;
  /** 靠别名匹配到时写在名称后面的小字（“别名 neko”）。 */
  via?: ReactNode;
  /** 未翻译：名称后加 Languages 图标。 */
  untranslated?: boolean;
  /** 靠右的读数，例如张数。 */
  meta?: ReactNode;
  /** 指示列里的图标。 */
  icon?: ReactNode;
  /** 分组名：和上一项不同时，先列一行分组名。 */
  group?: string;
  create?: boolean;
};

/** 把 `text` 里与 `query` 相同的部分（不分大小写）包进 `<mark>`。 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const hay = text.toLocaleLowerCase();
  let from = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

type Props<T extends ComboboxOption> = {
  value: string;
  onValueChange: (text: string) => void;
  options: T[];
  /** 选中一项（Enter 或单击）；从事件读 Alt、Ctrl 等修饰键。 */
  onSelect: (option: T, event: KeyboardEvent<HTMLInputElement> | MouseEvent<HTMLElement>) => void;
  /** 输入框的可访问名称。 */
  label: string;
  /** 有字但没有匹配时，列表第一行的提示（“没有匹配的标签”）。 */
  empty?: ReactNode;
  /** 默认高亮第一项，Enter 直接选它；自由输入的框关掉，Enter 交给 `onKeyDown`。 */
  autoHighlight?: boolean;
  /** 在空框里按退格。 */
  onBackspaceEmpty?: () => void;
  /** 先于内置按键处理；调用 `preventDefault()` 跳过内置处理。 */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** 只渲染输入框，外框由调用方给（查找框）；列表对齐 `anchor`。 */
  bare?: boolean;
  anchor?: RefObject<HTMLElement | null>;
  /** 输入框前的 16 px 图标。 */
  leading?: ReactNode;
  /** 侧栏行内（24 高）。 */
  inline?: boolean;
  invalid?: boolean;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
} & Pick<InputHTMLAttributes<HTMLInputElement>, "placeholder" | "disabled" | "autoFocus" | "id" | "title" | "onFocus" | "onBlur">;

/**
 * 带候选列表的输入框（设计系统 Combobox）：输入框 `role="combobox"`，高亮项用 `aria-activedescendant`
 * 指出，焦点始终留在输入框里。列表是 `.k-popup.k-listbox`，与输入框（或 `anchor`）同宽、下方 4 px，
 * 最多约 8 行，超出滚动。获得焦点或打字时展开；↑↓ 移动高亮，Enter 选中并收起，Esc 与 Tab 收起。
 */
export function Combobox<T extends ComboboxOption>({
  value, onValueChange, options, onSelect, label, empty, autoHighlight = true, onBackspaceEmpty, onKeyDown,
  bare, anchor, leading, inline, invalid, className = "", inputRef, placeholder, disabled, autoFocus, id, title, onFocus, onBlur,
}: Props<T>) {
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (i: number) => `${base}-opt-${i}`;
  const [open, setOpen] = useState(false);
  const start = autoHighlight ? 0 : -1;
  const [active, setActive] = useState(start);
  const box = useRef<HTMLDivElement>(null);
  const ownInput = useRef<HTMLInputElement>(null);
  const field = inputRef ?? ownInput;
  const list = useRef<HTMLDivElement>(null);

  // 改了字或候选换了，高亮回到第一项（或不高亮）。
  const ids = options.map((o) => o.id).join("\n");
  useEffect(() => setActive(start), [ids, start, value]);
  const current = active >= 0 && active < options.length ? active : -1;

  // 高亮项滚进列表可见范围。
  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const showEmpty = !!empty && value.trim() !== "";
  const shown = open && !disabled && (options.length > 0 || showEmpty);

  const pick = (option: T, event: KeyboardEvent<HTMLInputElement> | MouseEvent<HTMLElement>) => {
    setOpen(false);
    onSelect(option, event);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法选字时的方向键和回车属于输入法，不动候选。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const n = options.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (!n) return;
        event.preventDefault();
        if (!shown) { setOpen(true); return; }
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(current < 0 ? (step > 0 ? 0 : n - 1) : (current + step + n) % n);
        return;
      }
      case "Enter":
        if (shown && current >= 0) {
          event.preventDefault();
          pick(options[current], event);
        }
        return;
      case "Escape":
        if (shown) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        return;
      case "Tab":
        setOpen(false);
        return;
      case "Backspace":
        if (!value && onBackspaceEmpty) onBackspaceEmpty();
        return;
    }
  };

  const input = <input
    ref={field} id={id} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={shown}
    aria-controls={shown ? listId : undefined} aria-activedescendant={shown && current >= 0 ? optionId(current) : undefined}
    autoComplete="off" spellCheck={false} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} title={title}
    value={value}
    onChange={(event) => { onValueChange(event.target.value); setOpen(true); }}
    onKeyDown={keyDown}
    onFocus={(event) => { setOpen(true); onFocus?.(event); }}
    onBlur={(event) => { setOpen(false); onBlur?.(event); }}
  />;

  let group: string | undefined;
  const rows = options.map((option, i) => {
    const heading = option.group !== undefined && option.group !== group ? option.group : null;
    group = option.group;
    return <Fragment key={option.id}>
      {heading !== null && <div className="k-menu-label" role="presentation">{heading}</div>}
      {option.create && (i > 0 || showEmpty) && <div className="k-sep" role="separator" />}
      <div id={optionId(i)} role="option" aria-selected={i === current}
        className={`k-item k-option${option.create ? " is-create" : ""}`} data-highlighted={i === current ? "" : undefined}
        onMouseMove={() => i !== current && setActive(i)}
        onClick={(event) => pick(option, event)}>
        <span className="k-item-ind" aria-hidden="true">{option.create ? <Plus size={16} /> : option.icon}</span>
        <span className="k-item-label">{option.label}</span>
        {option.untranslated && <span className="k-option-flag" role="img" aria-label="未翻译" title="未翻译"><Languages size={14} aria-hidden="true" /></span>}
        {option.via && <span className="k-option-via">{option.via}</span>}
        {option.meta !== undefined && option.meta !== null && <span className="k-item-meta">{option.meta}</span>}
      </div>
    </Fragment>;
  });

  // 收起时浮层还要淡出一会儿：这期间留着收起前的内容，不闪出一个空浮层。
  const content = <>
    {showEmpty && options.every((o) => o.create) && <div className="k-option-empty">{empty}</div>}
    {rows}
  </>;
  const last = useRef(content);
  if (shown) last.current = content;

  return <div ref={box} className={`k-combo${bare ? " is-bare" : ""} ${bare ? className : ""}`}>
    {bare ? input : <div className={`k-input${inline ? " is-inline" : ""} ${className}`} data-disabled={disabled || undefined} data-invalid={invalid || undefined}>
      {leading}{input}
    </div>}
    <Popover.Root open={shown} modal={false}>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner is-field" anchor={anchor ?? box} side="bottom" align="start" sideOffset={4}>
          <Popover.Popup ref={list} id={listId} role="listbox" aria-label={label} className="k-popup k-listbox" initialFocus={false} finalFocus={false}
            // 点选时不让输入框失去焦点，列表不会先收起。
            onMouseDown={(event) => event.preventDefault()}>
            {shown ? content : last.current}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
