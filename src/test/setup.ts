import { configure } from "@testing-library/react";

// findBy*/waitFor 默认只等 1 秒。Windows CI 上 76 个 jsdom 文件并行时，打开对话框、读取预览这类
// 几步异步后才出现的元素偶尔超过 1 秒（ImportMenu、WorkspaceSources 先后因此失败），放宽到 5 秒。
configure({ asyncUtilTimeout: 5000 });
