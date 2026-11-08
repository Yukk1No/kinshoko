// PROTOTYPE（图标轨图标）：rail-prototype.html 的开发服务器。缩略图换成按编号生成的柔和色块。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hues = [350, 20, 40, 160, 200, 230, 270, 300];

export default defineConfig({
  plugins: [react(), {
    name: "proto-thumbs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/__proto\/[a-z]+\/L1\/p(\d+)\//);
        if (!match) return next();
        const n = Number(match[1]);
        const hue = hues[n % hues.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 78%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 45% 58%)"/></linearGradient></defs>
<rect width="100" height="100" fill="url(#g)"/><circle cx="${30 + (n * 17) % 40}" cy="${35 + (n * 11) % 30}" r="${14 + (n % 4) * 4}" fill="hsl(${hue} 70% 92% / .55)"/></svg>`;
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(svg);
      });
    },
  }],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1430, strictPort: true, open: false },
});
