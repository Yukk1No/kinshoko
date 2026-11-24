import { createElement, type ComponentType, type ReactNode } from "react";
import { cleanup, configure } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, vi } from "vitest";
// 组件按界面语言取文案（#353）：单独渲染组件的测试也要先初始化 i18n，默认简体中文。
import "../i18n/instance";
import { resetPlatform } from "./platform";
import { ToastProvider } from "../ui/Toast";

// 窗口里的组件都在 ToastProvider 之内，单独渲染时也一样（#433）。
vi.mock("@testing-library/react", async (original) => {
  const library = await original<typeof import("@testing-library/react")>();
  return {
    ...library,
    render: (ui: ReactNode, options?: { wrapper?: ComponentType<{ children: ReactNode }> }) => {
      const Inner = options?.wrapper;
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(ToastProvider, null, Inner ? createElement(Inner, null, children) : children);
      return library.render(ui, { ...options, wrapper } as Parameters<typeof library.render>[1]);
    },
  };
});

// findBy*/waitFor 默认只等 1 秒。Windows CI 上 76 个 jsdom 文件并行时，打开对话框、读取预览这类
// 几步异步后才出现的元素偶尔超过 1 秒（ImportMenu、WorkspaceSources 先后因此失败），放宽到 5 秒。
//
// base-ui 给高优先级轻提示（toast.error）另渲染一份隐藏的读屏文字（role="alert" aria-atomic）。按文字查找时
// 跳过这份副本，否则两份都在：findByText 只有赶在第二份出现前查到才通过，CI 上时序一变就失败。
configure({ asyncUtilTimeout: 5000, defaultIgnore: 'script, style, [role="alert"][aria-atomic="true"] > div' });

// 每个用例之后：卸载界面，等卸载时异步取消的事件订阅完成，再撤掉 Tauri 的模拟（#520），
// 最后让补上的浏览器接口回到初始状态（#537）。
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  resetPlatform();
});
