/**
 * 封印书的小圆锁（品牌不变项，design/ui-system/README.md）：原型 `prototype/reference-browser/src/sealbook.ts`
 * 的 `lockSVG(0, …)` 静止帧，按原几何原样输出（U 形锁梁 + 圆锁身 + 书签锁孔），颜色用 `--seal-acc`。
 */
export function SealLock({ size = 10, className = "" }: { size?: number; className?: string }) {
  return <svg className={`k-seal-lock ${className}`} width={size * 1.6} height={size * 1.76} viewBox="7 4 10 11" aria-hidden="true" style={{ overflow: "visible" }}>
    <path d="M10.5 9.6 V7 A1.5 1.5 0 0 1 13.5 7 V8.8" fill="none" stroke="var(--seal-acc)" strokeWidth="1" />
    <path d="M9 11 A3 3 0 1 0 15 11 A3 3 0 1 0 9 11 Z M11.7 11.34 A0.8 0.8 0 1 1 12.3 11.34 L12.5 13.1 H11.5 Z" fillRule="evenodd" fill="var(--seal-acc)" />
  </svg>;
}
