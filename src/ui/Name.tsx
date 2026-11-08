import { useState, type ReactNode } from "react";
import { Tip } from "./Tip";

/**
 * 用户自己起的名字（文件名、图库名、参考组名、标签名、文件夹名）：放不下时用省略号截断，被截断时悬停提示给全名。
 * 程序自己的文字不用它（见 interface-text-rules.md「不截断」）。`full` 是提示里的全名，缺省取 `children`（须为字符串）。
 */
export function Name({ children, full, className = "" }: { children: ReactNode; full?: string; className?: string }) {
  const [cut, setCut] = useState(false);
  const text = full ?? (typeof children === "string" ? children : "");
  const measure = (el: HTMLElement) => setCut(el.scrollWidth > el.clientWidth);
  return <Tip label={cut ? text : ""} focus={false}>
    <span className={`k-name ${className}`.trim()} onPointerEnter={(e) => measure(e.currentTarget)}>{children}</span>
  </Tip>;
}
