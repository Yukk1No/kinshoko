import { createContext, useContext } from "react";

/** 订阅页墙的图片大小（与图片页共用一个设置，在头像卡里调）。为 null 时用墙的默认值。 */
export const PixivDensityContext = createContext<number | null>(null);

export const usePixivDensity = () => useContext(PixivDensityContext);
