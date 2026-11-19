import { useId } from "react";

const FLAP = "M6.6 11 L22.4 11 L19.8 20 L4 20 Z";

/**
 * 有子文件夹的文件夹（#608）：两层，后面的夹子与前面的一页。展开时前面那一页翻下来，折起时合上；
 * 两种样子是同一条路径在变（CSS 的 `d`），指针停在图标上时先变成点下去之后的样子。
 * 图标不填色：后面的夹子被前面一页挡住的线由遮罩挖掉，遮罩里的那一页与前面一页同一个类，跟着它变形。
 */
export function FoldIcon() {
  const cut = useId();
  return (
    <svg className="k-fold-icon" viewBox="0 0 24 24" aria-hidden="true">
      <mask id={cut} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
        <rect x="-2" y="-2" width="28" height="28" fill="white" />
        <path className="flap" d={FLAP} />
      </mask>
      <path
        className="back"
        mask={`url(#${cut})`}
        d="M2 18V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H19a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"
      />
      <path className="flap" d={FLAP} />
    </svg>
  );
}
