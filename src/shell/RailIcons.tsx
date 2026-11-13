import { useId, type ComponentType, type SVGProps } from "react";

// 图标轨里要按部件做悬停动效的图标：图片与收件盘的外形照 lucide 1.52 的 Images 与 Inbox，取景框照 Scan 加一幅画；
// 24 网格、线宽跟着 strokeWidth。
// lucide 只画露出来的线，被挡住的部分没有；部件一移开就露出缺口，所以这里把被挡的部件画完整，
// 再用遮罩藏起挡住的那块。遮罩里的形状跟着挡在前面的部件一起动（shell.css 的 `.rail-ic-browse`、`.rail-ic-subscriptions`）。

type IconProps = { size?: number; strokeWidth?: number; className?: string };
/** 图标轨能放的图标：lucide 的或这里自画的。 */
export type RailIcon = ComponentType<IconProps>;

const svgProps = ({ size = 24, strokeWidth = 2, className }: IconProps): SVGProps<SVGSVGElement> => ({
  xmlns: "http://www.w3.org/2000/svg",
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className,
  "aria-hidden": true,
});

/** 遮罩的 id 不能带冒号（`url(#…)` 里会断开）。 */
const useMaskId = () => `rail-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

/** 图片与文件夹：前后两张图。悬停时两张图沿底边扇开，像翻相册。 */
export function RailImagesIcon(p: IconProps) {
  const mask = useMaskId();
  return (
    <svg {...svgProps(p)}>
      <mask id={mask} maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36">
        <rect x="-6" y="-6" width="36" height="36" fill="#fff" stroke="none" />
        {/* 前面那张图占的地方，外扩一圈留出缝 */}
        <rect
          className="images-cut rail-part"
          x="8"
          y="2"
          width="14"
          height="14"
          rx="2"
          fill="#000"
          stroke="#000"
          strokeWidth="4"
        />
      </mask>
      <g className="images-back">
        <rect x="2" y="8" width="14" height="14" rx="2" mask={`url(#${mask})`} />
      </g>
      <g className="images-front">
        <rect x="8" y="2" width="14" height="14" rx="2" />
        <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
        <circle cx="13" cy="7" r="1" fill="currentColor" />
      </g>
    </svg>
  );
}

/** 订阅：收件盘。悬停时一封信从盘口被抽出来。 */
export function RailInboxIcon(p: IconProps) {
  const mask = useMaskId();
  const clip = `${mask}-clip`;
  return (
    <svg {...svgProps(p)}>
      {/* 盘沿以上：信从盘沿后面露出来，盘沿以下的部分藏着 */}
      <clipPath id={clip}>
        <path d="M-6 12H8l2 3h4l2-3h14V-8H-6Z" />
      </clipPath>
      <mask id={mask} maskUnits="userSpaceOnUse" x="-6" y="-8" width="36" height="36">
        <rect x="-6" y="-8" width="36" height="36" fill="#fff" stroke="none" />
        <g clipPath={`url(#${clip})`}>
          <rect
            className="inbox-letter rail-part"
            x="7"
            y="1.5"
            width="10"
            height="7"
            rx="1.5"
            fill="#000"
            stroke="#000"
            strokeWidth="4"
          />
        </g>
      </mask>
      <path
        className="inbox-box"
        mask={`url(#${mask})`}
        d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
      />
      <g clipPath={`url(#${clip})`}>
        <g className="inbox-letter rail-part">
          <rect x="7" y="1.5" width="10" height="7" rx="1.5" />
          <path d="m7.5 2.5 4.5 3.2 4.5-3.2" />
        </g>
      </g>
      <polyline className="inbox-lip" points="22 12 16 12 14 15 10 15 8 12 2 12" />
    </svg>
  );
}

/** 截图（截图历史）：取景框。悬停时四个角往里收，框里的画随后被描上一圈边，成了一张截下来的图。 */
export function RailViewfinderIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path className="view-tl" d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path className="view-tr" d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path className="view-br" d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path className="view-bl" d="M7 21H5a2 2 0 0 1-2-2v-2" />
      {/* 平头线帽：没描出来时虚线是零长度的一段，圆头会在起点留下一个点 */}
      <rect className="view-frame" x="7" y="7" width="10" height="10" rx="1.5" pathLength={1} strokeLinecap="butt" />
      <path d="m8.5 15.5 3-3 2 2 1.5-1.5 1.5 1.5" />
      <circle cx="14.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
