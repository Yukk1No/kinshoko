import { createContext, useContext } from "react";

/** 订阅页墙的图片大小（与图片页共用一个设置，在头像卡里调）。为 null 时用墙的默认值。 */
export const PixivDensityContext = createContext<number | null>(null);

/** 头像卡里的图片大小滑条：当前值与松手时写回设置。 */
export type DensityControl = { value: number; onCommit: (value: number) => void };

export const usePixivDensity = () => useContext(PixivDensityContext);
