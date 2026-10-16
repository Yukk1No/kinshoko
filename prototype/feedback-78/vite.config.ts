// PROTOTYPE：只服务 prototype/feedback-78，不影响正式构建。
// App.tsx 里的几个模块在这里换成方案包装；包装在 ?bar=0 / ?side=0 时原样渲染正式组件。
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const swaps: Record<string, string> = {
  "./library/WorkspacePane": resolve(here, "ProtoWorkspacePane.tsx"),
  "./library/LibraryPicker": resolve(here, "ProtoLibraryPicker.tsx"),
  "./search/TagGroupBar": resolve(here, "ProtoTagGroupBar.tsx"),
};
const swap: Plugin = {
  name: "proto-78-swap",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer && /[\\/]src[\\/]App\.tsx$/.test(importer) && swaps[source]) return swaps[source];
    return null;
  },
};

export default defineConfig({
  root: here,
  plugins: [swap, react()],
  server: { host: "127.0.0.1", port: 1478, strictPort: true, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
