// shared-tag-groups.mjs helpers: fixture PNGs, the old-schema library fixture and the WebDriver client.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
export const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
export function png(red) {
  const row = Buffer.from([0, red, 28, 38, red, 28, 38, red, 28, 38]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]);
}
export function oldLibrary({ libraries, oldSchema }, name, primary, red, isAdult) {
  const root = join(libraries, name); mkdirSync(root);
  const db = new DatabaseSync(join(root, "library.sqlite")); db.exec(oldSchema);
  const identity = (value) => createHash("sha256").update(name + value).digest("hex").slice(0, 32);
  const id = identity("library"); db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id, name);
  const tags = {};
  function addTag(key, label, namespace = "general", external = key) {
    const local = identity(key + namespace); tags[key + namespace] = local;
    db.prepare("INSERT INTO tag VALUES (?,?,1000)").run(local, namespace);
    db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(local, label);
    if (external) db.prepare("INSERT INTO tag_external VALUES (?,?)").run(external, local);
    return local;
  }
  const blue = addTag("blue_hair", "蓝发"), purple = addTag("purple_hair", "紫发"), secret = addTag("spec78_secret", "封印专用词");
  const workTag = addTag("星海", "星海", "work", null), artistTag = addTag("星海", "星海", "artist", null);
  const originals = [];
  function addImage(key, color, ids, adult = false) {
    const bytes = png(color), sha = createHash("sha256").update(bytes).digest("hex");
    const rel = `originals/${sha.slice(0, 2)}/${sha}.png`;
    mkdirSync(join(root, "originals", sha.slice(0, 2)), { recursive: true }); writeFileSync(join(root, rel), bytes);
    const imageId = identity(key);
    db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at,rating_manual) VALUES (?,?,?,'png',?,3,3,1,?,1000,?)").run(imageId, sha, bytes.length, rel, key + ".png", adult ? "explicit" : null);
    for (const tag of ids) {
      db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId, tag);
      db.prepare("INSERT INTO tag_decision VALUES (?,?,'add',1000)").run(imageId, tag);
    }
    originals.push({ imageId, path: join(root, rel), sha }); return imageId;
  }
  const primaryId = addImage("primary", red, [primary === "blue" ? blue : purple, workTag, artistTag]);
  const secretId = addImage("secret", 99, [secret], isAdult);
  // The blue file has different local IDs in the two providers but one byte identity.
  if (primary !== "blue") addImage("shared-blue", 10, [blue]);
  const groupId = identity("group-hair");
  db.prepare("INSERT INTO tag_group VALUES (?, '发色', NULL,0,1000)").run(groupId);
  db.prepare("INSERT INTO tag_group_member VALUES (?,?,0)").run(groupId, primary === "blue" ? blue : purple);
  if (primary === "blue") db.prepare("INSERT INTO tag_group VALUES (?, '作品','work',1,1000)").run(identity("group-work"));
  db.close(); return { info: { id, root, name }, groupId, primaryId, secretId, tags, originals };
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
  class Session {
    static async start() {
      const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
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
      for (let attempt = 0; ; attempt++) {
        try { return await this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
        catch (error) {
          if (attempt >= 4 || !/stale element reference|no such element/.test(error.message)) throw error;
          await delay(150);
        }
      }
    }
    async set(xpath, value) {
      await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!element) throw Error('control missing'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, arguments[1]); element.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]);
    }
    async select(xpath, value) {
      await until("enabled select option", () => this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return element && !element.disabled && [...element.options].some((option) => option.value === arguments[1]);", [xpath, value]));
      await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; element.value = arguments[1]; element.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]);
    }
    key(value) { return wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] }); }
    async controlClick(xpath) {
      await wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: String.fromCharCode(0xE009) }] }] });
      try { await this.click(xpath); } finally { await wd("DELETE", `${this.base}/actions`); }
    }
    close() { return wd("DELETE", this.base); }
    async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
  }
  return { until, wd, delay, Session };
}
