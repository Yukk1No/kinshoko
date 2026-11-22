import { useId } from "react";
import { useTranslation } from "react-i18next";

/**
 * 详情栏开着、没有选中图片时（#608）：用矢量画一张抽象的详情栏——图、名字、几枚标签、几行信息，
 * 下面一句很短的提示。只是轮廓，不像正在加载，也不会被当成真的内容去点。
 */
export function InspectorEmpty() {
  const { t } = useTranslation("workspace");
  const clip = useId();
  return (
    <div className="insp-empty" role="note">
      <svg className="insp-empty-art" viewBox="0 0 200 196" aria-hidden="true">
        <clipPath id={clip}>
          <rect x="0.5" y="0.5" width="199" height="112" rx="10" />
        </clipPath>
        <rect className="frame" x="0.5" y="0.5" width="199" height="112" rx="10" />
        <g clipPath={`url(#${clip})`}>
          <circle className="sun" cx="150" cy="34" r="11" />
          <path className="hill far" d="M0 92 L48 52 L84 80 L118 58 L200 100 V113 H0 Z" />
          <path className="hill near" d="M0 102 L60 74 L112 102 L150 88 L200 108 V113 H0 Z" />
        </g>
        <rect className="line strong" x="0" y="128" width="112" height="8" rx="4" />
        <rect className="line" x="0" y="144" width="68" height="6" rx="3" />
        <rect className="pill accent" x="0" y="164" width="44" height="16" rx="8" />
        <rect className="pill" x="50" y="164" width="58" height="16" rx="8" />
        <rect className="pill" x="114" y="164" width="36" height="16" rx="8" />
      </svg>
      <p className="k-description insp-empty-text">{t("inspector.empty")}</p>
    </div>
  );
}
