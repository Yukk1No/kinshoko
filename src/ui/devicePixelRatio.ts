import { useEffect, useState } from "react";

/**
 * 跟随 `window.devicePixelRatio`：换显示器、改系统缩放或界面缩放（#173）时更新。
 * 界面缩放由 WebView 异步生效，这个值可能晚于档位到达，所以要监听，不能只在渲染时读一次。
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const sync = () => setDpr(window.devicePixelRatio || 1);
    sync();
    // 缩放变化不一定改变视口大小，所以同时监听分辨率。
    const resolution = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    resolution?.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      resolution?.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [dpr]);
  return dpr;
}
