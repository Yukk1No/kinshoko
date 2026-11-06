import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeDetails, RuntimeNotice, RuntimeProvider } from "./RuntimeSupport";

afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); });

const failing = (calls: string[] = []) => mockIPC((command) => {
  calls.push(command);
  return command === "runtime_status" ? { webview2: "154.0.4258.62", assessment: { problems: ["decodeMissing"] } } : null;
});

it("reports a failed capability as one notice that opens the details and leaves browsing usable", async () => {
  failing();
  const onOpen = vi.fn();
  render(<RuntimeProvider><RuntimeNotice hidden={false} onOpen={onOpen} /><button>打开参考图</button></RuntimeProvider>);
  const title = await screen.findByText("运行环境检查未通过");
  expect(title.closest(".k-toast")?.getAttribute("data-tone")).toBe("error");
  expect(screen.queryByText(/缺少图片解码接口/)).toBeNull();
  expect(screen.getByRole("button", { name: "打开参考图" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "查看", hidden: true }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("collapses the notice once a recheck passes and shows it again if the problem comes back", async () => {
  let problems = ["decodeMissing"];
  mockIPC((command) => command === "runtime_status" ? { webview2: "1", assessment: { problems } } : null);
  render(<RuntimeProvider><RuntimeNotice hidden={false} onOpen={() => {}} /><RuntimeDetails /></RuntimeProvider>);
  await screen.findByText("运行环境检查未通过");
  fireEvent.click(screen.getByRole("button", { name: "知道了", hidden: true }));
  await waitFor(() => expect(screen.queryByText("运行环境检查未通过")).toBeNull());
  problems = [];
  fireEvent.click(screen.getByRole("button", { name: "检查" }));
  await screen.findByText("正常");
  problems = ["decodeMissing"];
  fireEvent.click(screen.getByRole("button", { name: "检查" }));
  expect(await screen.findByText("运行环境检查未通过")).toBeTruthy();
});

it("steps aside while settings is open, without counting as dismissed", async () => {
  failing();
  function Host() {
    const [hidden, setHidden] = useState(false);
    return <><RuntimeNotice hidden={hidden} onOpen={() => setHidden(true)} /><button onClick={() => setHidden(false)}>关闭设置</button></>;
  }
  render(<RuntimeProvider><Host /></RuntimeProvider>);
  await screen.findByText("运行环境检查未通过");
  fireEvent.click(screen.getByRole("button", { name: "查看", hidden: true }));
  await waitFor(() => expect(screen.queryByText("运行环境检查未通过")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  expect(await screen.findByText("运行环境检查未通过")).toBeTruthy();
});

it("keeps the reason and the update action inside the settings runtime section", async () => {
  const calls: string[] = [];
  failing(calls);
  render(<RuntimeProvider><RuntimeDetails /></RuntimeProvider>);
  expect((await screen.findByRole("alert")).textContent).toContain("缺少图片解码接口");
  expect(screen.getByText("微软 WebView2 下载页")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开" }));
  await waitFor(() => expect(calls).toContain("open_runtime_update"));
});
