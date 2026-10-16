/**
 * 封印书：安全模式的开关（第五轮 A1 圆锁，#27）。合上的书带一把圆锁表示开启，
 * 翻开的书表示关闭。快捷键 Ctrl+Shift+S 由主窗口处理。
 */
export function SealBook({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="seal-book"
      aria-pressed={on}
      aria-label={on ? "安全模式：开启" : "安全模式：关闭"}
      title={`${on ? "安全模式已开启：含成人内容的参考图已封印" : "安全模式已关闭"}（Ctrl+Shift+S）`}
      onClick={onToggle}
      data-on={on}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        {on ? (
          <>
            {/* 合上的书 */}
            <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z" className="seal-book-cover" />
            <path d="M5 17.5a2 2 0 0 1 2-2h11" className="seal-book-edge" />
            {/* 圆锁 */}
            <circle cx="11.5" cy="10.5" r="3.6" className="seal-book-lock" />
            <path d="M10.3 10.5h2.4M11.5 9.3v2.4" className="seal-book-key" />
          </>
        ) : (
          <>
            {/* 翻开的书 */}
            <path d="M3 6.5c3-1.2 6-1.2 9 .8v12c-3-2-6-2-9-.8z" className="seal-book-cover" />
            <path d="M21 6.5c-3-1.2-6-1.2-9 .8v12c3-2 6-2 9-.8z" className="seal-book-cover" />
          </>
        )}
      </svg>
    </button>
  );
}
