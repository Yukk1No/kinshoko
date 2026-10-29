/// <reference types="vitest/config" />
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const local = resolve(import.meta.dirname, '.local');
const types: Record<string, string> = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };

// The generated library stays out of git: it is built from non-redistributable samples.
function sampleLibrary(): Plugin {
  const id = 'virtual:library';
  return {
    name: 'kinshoko-sample-library',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load(source) {
      if (source !== '\0' + id) return;
      const file = join(local, 'library.json');
      if (existsSync(file)) this.addWatchFile(file);
      return `export default ${existsSync(file) ? readFileSync(file, 'utf8') : '{"missing":true,"images":[],"tags":{}}'};`;
    },
    configureServer(server) {
      // Sample images and the #28 fonts (scripts/fetch_fonts.py) are served from .local, never bundled.
      for (const dir of ['media', 'fonts']) {
        server.middlewares.use(`/${dir}`, (req, res, next) => {
          const path = normalize(join(local, dir, decodeURIComponent((req.url ?? '').split('?')[0])));
          if (!path.startsWith(join(local, dir)) || !existsSync(path) || !statSync(path).isFile()) return next();
          res.setHeader('Content-Type', types[extname(path).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'max-age=3600');
          createReadStream(path).pipe(res);
        });
      }
    },
    closeBundle() {
      for (const dir of ['media', 'fonts']) {
        if (existsSync(join(local, dir))) cpSync(join(local, dir), resolve(import.meta.dirname, 'dist', dir), { recursive: true });
      }
    },
  };
}

// A single inlined index.html opens from file:// with a double click: the artist runs it without a dev environment.
export default defineConfig({
  base: './',
  plugins: [react(), sampleLibrary(), viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 4000 },
  test: { environment: 'node' },
});
