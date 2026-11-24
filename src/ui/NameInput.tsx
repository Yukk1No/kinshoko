import { useState, type KeyboardEvent } from "react";
import { isComposingKey } from "./composing";

/** 只在文本框里按 Enter 提交、Esc 放弃。 */
export function NameInput(props: { label: string; initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(props.initial);
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === "Enter") props.onDone(value.trim() || null);
    if (e.key === "Escape") props.onDone(null);
  };
  return (
    <input
      className="k-input is-inline"
      aria-label={props.label}
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={key}
      onBlur={() => props.onDone(value.trim() || null)}
    />
  );
}
