import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 开发服务器地址须与 src-tauri/tauri.conf.json 的 build.devUrl 一致。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    // 运行环境基线（WebView2 131）：与 AGENTS.md 的“Runtime baseline”和 CI 的系统镜像一起改。
    target: "chrome131",
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    setupFiles: ["src/test/setup.ts"],
    // 单个用例常连等几处 findBy；每处最多等 5 秒（src/test/setup.ts），整条用例的上限随之放宽。
    testTimeout: 20000,
    // 让 `?raw` 读到真实样式表（封印书样式与原型的比对测试）；普通 CSS 导入仍为空。
    css: { include: [/\.css\?raw$/] },
  },
});
