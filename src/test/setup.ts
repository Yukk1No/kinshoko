import { configure } from "@testing-library/react";
// 组件按界面语言取文案（#353）：单独渲染组件的测试也要先初始化 i18n，默认简体中文。
import "../i18n/instance";

// findBy*/waitFor 默认只等 1 秒。Windows CI 上 76 个 jsdom 文件并行时，打开对话框、读取预览这类
// 几步异步后才出现的元素偶尔超过 1 秒（ImportMenu、WorkspaceSources 先后因此失败），放宽到 5 秒。
configure({ asyncUtilTimeout: 5000 });
