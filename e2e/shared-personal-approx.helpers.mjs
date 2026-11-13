// shared-personal-approx.mjs helpers: the WebDriver client (tauri-driver session, polling, element actions).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDriver } from "./lib/driver.mjs";

export function driverClient({ driverUrl, application, work }) {
  const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
  const { wd, until, delay } = createDriver({ driverUrl });
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
