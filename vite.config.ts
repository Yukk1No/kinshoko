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
    target: "chrome120",
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
