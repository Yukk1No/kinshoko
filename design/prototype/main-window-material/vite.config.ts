// 质感原型（#606）自己的开发服务器：根目录是仓库根，所以原型直接引用 src/ 里的真实组件与样式表。
// 运行：npx vite --config design/prototype/main-window-material/vite.config.ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** 样张：缩略图地址 `/__thumb/<图库>/<图>/<档位>` 回一张色块，颜色与明暗由图的编号决定。不放任何真实图片。 */
function swatches(): Plugin {
  return {
    name: "prototype-swatches",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/__thumb\/[^/]+\/p(\d+)-(\d+)x(\d+)\//.exec(request.url ?? "");
        if (!match) return next();
        const [n, w, h] = match.slice(1).map(Number);
        const hue = (n * 47) % 360;
        const light = 38 + ((n * 29) % 40);
        const chroma = n % 5 === 0 ? 0 : 0.03 + ((n * 13) % 9) / 100;
        const from = `oklch(${light}% ${chroma} ${hue})`;
        const to = `oklch(${Math.max(18, light - 22)}% ${chroma * 0.8} ${(hue + 28) % 360})`;
        const spot = `oklch(${Math.min(94, light + 24)}% ${chroma * 0.6} ${(hue + 340) % 360})`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>
<radialGradient id="s" cx="${0.25 + (n % 4) * 0.17}" cy="${0.22 + (n % 3) * 0.2}" r="0.55"><stop offset="0" stop-color="${spot}" stop-opacity="0.85"/><stop offset="1" stop-color="${spot}" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#s)"/></svg>`;
        response.setHeader("Content-Type", "image/svg+xml");
        response.setHeader("Cache-Control", "max-age=3600");
        response.end(svg);
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), swatches()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1431, strictPort: true, open: false, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
});
