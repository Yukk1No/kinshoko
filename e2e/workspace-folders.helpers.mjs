// workspace-folders.mjs helpers: fixture PNGs and the WebDriver client.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
export function writeFixturePng(imagePath) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, 18, 28, 38, 18, 28, 38, 18, 28, 38]);
  writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]));
}
export function png(path, seed) {
  const header = Buffer.alloc(13); header.writeUInt32BE(120, 0); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(361); row[0] = 0;
  for (let x = 0; x < 120; x++) { row[x * 3 + 1] = seed; row[x * 3 + 2] = 28; row[x * 3 + 3] = 38; }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 90 }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
}

export function driverClient({ driverUrl, application, work }) {
  const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
  async function wd(method, path, body) {
    const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
    return result.value;
  }
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  async function until(label, read, timeout = 30000) {
    const end = Date.now() + timeout;
    let error;
    while (Date.now() < end) {
      try { const result = await read(); if (result) return result; } catch (reason) { error = reason; }
      await delay(150);
    }
    throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
  }
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
    async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
    async click(xpath) {
      return until("click " + xpath, async () => {
        const id = await this.find(xpath);
        await wd("POST", `${this.base}/element/${id}/click`, {});
        return true;
      });
    }
    async type(xpath, value) { const id = await this.find(xpath); return wd("POST", `${this.base}/element/${id}/value`, { text: value, value: [...value] }); }
    close() { return wd("DELETE", this.base); }
    async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
  }
  return { ELEMENT, wd, delay, until, assertions, assert, Session };
}
