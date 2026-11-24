import { TriangleAlert } from "lucide-react";

/**
 * 警告文字旁的三角图标（#482）：琥珀橙和危险红色相相近，警告不能只靠颜色认出来。
 * 跟着文字的颜色；放在文字前面，多行时对齐第一行（`.k-warn-icon`）。
 */
export function WarnIcon({ size = 12 }: { size?: number }) {
  return <TriangleAlert className="k-warn-icon" size={size} strokeWidth={2} aria-hidden="true" />;
}
