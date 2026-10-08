import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ModelChoice } from "./bindings/ModelChoice";
import { ModelSettings } from "./ModelSettings";

afterEach(() => {
  cleanup();
  clearMocks();
  delete window.__KINSHOKO_TEST_PICKS__;
});

const choice: ModelChoice = {
  selected: null,
  options: [
    {
      key: "pixai-v1.0-fp16-chunked",
      label: "PixAI Tagger v1.0 FP16（显卡）",
      device: "directMl",
      vramNeed: 1_800_000_000,
      ramNeed: 0,
      size: 992_916_002,
      installed: true,
    },
    {
      key: "pixai-v1.0-fp32-chunked",
      label: "PixAI Tagger v1.0 FP32（CPU）",
      device: "cpu",
      vramNeed: 0,
      ramNeed: 5_000_000_000,
      size: 1_984_062_544,
      installed: false,
    },
  ],
};

function backend(handle: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "tagging_models") return choice;
    return handle(cmd, a);
  });
  return calls;
}

describe("设置：自动标签模型", () => {
  it("列出每个模型的显存或内存需求与是否已下载，默认自动选择", async () => {
    backend(() => undefined);
    render(<ModelSettings />);

    const auto = await screen.findByRole("radio", { name: /自动/ });
    expect((auto as HTMLInputElement).checked).toBe(true);
    const gpu = screen.getByRole("radio", { name: /FP16（显卡）/ });
    expect(gpu.closest("label")?.textContent).toMatch(/显存约 1.8 GB/);
    expect(gpu.closest("label")?.textContent).toMatch(/已下载/);
    const cpu = screen.getByRole("radio", { name: /FP32（CPU）/ });
    expect(cpu.closest("label")?.textContent).toMatch(/内存约 5.0 GB/);
    expect(cpu.closest("label")?.textContent).toMatch(/需下载 1984 MB/);
  });

  it("选一个模型即保存并显示核心返回的选择", async () => {
    const calls = backend((cmd, args) =>
      cmd === "tagging_set_model" ? { ...choice, selected: args.key } : undefined,
    );
    render(<ModelSettings />);

    fireEvent.click(await screen.findByRole("radio", { name: /FP32（CPU）/ }));

    await screen.findByRole("radio", { name: /FP32（CPU）/, checked: true });
    expect(calls.find((c) => c.cmd === "tagging_set_model")?.args).toEqual({
      key: "pixai-v1.0-fp32-chunked",
    });
  });

  it("从文件导入模型包，校验通过后显示已下载", async () => {
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\离线\\pixai.zip"];
    const calls = backend((cmd) =>
      cmd === "tagging_import_package"
        ? {
            ...choice,
            options: [choice.options[0], { ...choice.options[1], installed: true }],
          }
        : undefined,
    );
    render(<ModelSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "从文件导入模型包…" }));

    expect(await screen.findByText("模型包已导入并通过校验")).toBeTruthy();
    const cpu = screen.getByRole("radio", { name: /FP32（CPU）/ });
    expect(cpu.closest("label")?.textContent).toMatch(/已下载/);
    expect(calls.find((c) => c.cmd === "tagging_import_package")?.args).toEqual({
      path: "D:\\离线\\pixai.zip",
    });
  });

  it("模型包校验不过时显示原因", async () => {
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\坏包.zip"];
    backend((cmd) => {
      if (cmd === "tagging_import_package") throw "模型包校验失败：model.onnx 已损坏";
      return undefined;
    });
    render(<ModelSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "从文件导入模型包…" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("模型包校验失败：model.onnx 已损坏")).toBeTruthy();
  });

  it("取消选择文件时什么也不做", async () => {
    window.__KINSHOKO_TEST_PICKS__ = [null];
    const calls = backend(() => undefined);
    render(<ModelSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "从文件导入模型包…" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((c) => c.cmd === "tagging_import_package")).toBe(false);
  });
});
