// e2e 脚本共用的 WebDriver 客户端：直接说 W3C WebDriver 协议，只用 Node 自带模块。
// 本模块不读 process.argv、不调 process.exit；地址和被测程序路径都由脚本传进来。
import { spawnSync } from "node:child_process";

export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {object} options
 * @param {string} options.driverUrl 驱动地址，如 http://127.0.0.1:4444
 * @param {string} [options.application] 被测程序的完整路径；quitOwnApp 只结束路径与它相同的进程
 * @param {number} [options.timeout] 单个请求的超时毫秒数；不传则不设超时
 * @param {boolean} [options.legacyProtocol] 旧写法：响应带 status 字段也算失败，建会话时返回 { sessionId, capabilities }
 * @param {number} [options.untilTimeout] until 的默认超时毫秒数
 * @param {number} [options.every] until 的默认轮询间隔毫秒数
 */
export function createDriver({
  driverUrl,
  application,
  timeout,
  legacyProtocol = false,
  untilTimeout = 30000,
  every = 150,
}) {
  async function wd(method, path, body) {
    const response = await fetch(driverUrl + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout === undefined ? undefined : AbortSignal.timeout(timeout),
    });
    const result = await response.json();
    if (legacyProtocol) {
      if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
      return path === "/session" && result.sessionId
        ? { sessionId: result.sessionId, capabilities: result.value }
        : result.value;
    }
    if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
    return result.value;
  }

  async function until(label, read, timeoutMs = untilTimeout, interval = every) {
    const end = Date.now() + timeoutMs;
    let error;
    while (Date.now() < end) {
      try {
        const result = await read();
        if (result) return result;
      } catch (reason) {
        error = reason;
      }
      await delay(interval);
    }
    throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
  }

  /** 只结束可执行文件路径等于 application 的进程，不碰别的 kinshoko。 */
  function quitOwnApp() {
    if (!application) throw new Error("quitOwnApp 需要 createDriver 传入 application");
    return spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore", windowsHide: true },
    );
  }

  return { wd, until, quitOwnApp, delay };
}
