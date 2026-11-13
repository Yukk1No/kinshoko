// source-actions.mjs helpers: fixture image and the WebDriver client.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createDriver } from "./lib/driver.mjs";
import { chunk } from "./lib/fixtures.mjs";

export function writeTestPng(imagePath) {
  const width = 160, height = 120;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (1 + width * 3) + 1 + x * 3; pixels[offset] = 70 + x; pixels[offset + 1] = 60 + y; pixels[offset + 2] = 140; }
  writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
  return { width, height };
}

export function driverClient({ driverUrl, application, work }) {
  const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
  const { wd, until, delay } = createDriver({ driverUrl });
  const assertions = [];
  function assert(ok, label) { if (!ok) throw new Error(label); assertions.push(label); console.log(`PASS ${label}`); }
  class Session {
    static async start() {
      const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
      const session = new Session(result.sessionId);
      await until("Tauri IPC ready", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
      return session;
    }
    constructor(id) { this.base = `/session/${id}`; }
    exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
    async invoke(command, args = {}) {
      const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
      if (result.failure) throw new Error(`${command}: ${result.failure}`);
      return result.value;
    }
    async desktop(command, args = {}) {
      const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:desktop|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
      if (result.failure) throw new Error(`${command}: ${result.failure}`);
      return result.value;
    }
    async type(xpath, value) {
      const id = await this.find(xpath);
      await wd("POST", `${this.base}/element/${id}/clear`, {});
      return wd("POST", `${this.base}/element/${id}/value`, { text: value, value: [...value] });
    }
    async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
    async click(xpath) {
      const end = Date.now() + 10000;
      for (;;) {
        try { const id = await this.find(xpath); return await wd("POST", `${this.base}/element/${id}/click`, {}); }
        catch (error) {
          // These WebDriver errors mean the click did not run. Resolve the refreshed control once more.
          if (Date.now() >= end || !/stale element reference|no such element/.test(String(error))) throw error;
          await delay(150);
        }
      }
    }
    close() { return wd("DELETE", this.base); }
    async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
  }
  return { ELEMENT, wd, delay, until, assertions, assert, Session };
}
