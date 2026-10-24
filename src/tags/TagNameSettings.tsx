import { createContext, useContext } from "react";

/**
 * 打开 设置 › 标签 › 显示名 并定位到一个统一标签（#182）。主窗口提供；没有提供时（例如单独的面板测试）
 * 改名框里不出“在设置中管理”的链接。
 */
export const OpenTagNameSettings = createContext<((catalogId: string) => void) | null>(null);

export const useOpenTagNameSettings = () => useContext(OpenTagNameSettings);
