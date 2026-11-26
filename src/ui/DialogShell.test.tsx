import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AlertDialog, DialogShell } from "./DialogShell";

function pressBackdrop() {
  const backdrop = document.querySelector<HTMLElement>(".k-backdrop");
  if (!backdrop) throw new Error("没有遮罩");
  fireEvent.click(backdrop, { button: 0 });
}

function AlertSample({
  onOpenChange = () => {},
  busy = false,
}: {
  onOpenChange?: (open: boolean) => void;
  busy?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      busy={busy}
      onOpenChange={onOpenChange}
      title="永久删除"
      description="删除后不能恢复。"
      cancelRef={cancel}
      footer={
        <>
          <button ref={cancel} type="button">
            取消
          </button>
          <button type="button">删除</button>
        </>
      }
    />
  );
}

describe("DialogShell", () => {
  it("info 对话框默认有右上角关闭，初始焦点落在不画环的容器上", async () => {
    const onOpenChange = vi.fn();
    render(
      <DialogShell open purpose="info" title="说明" closeLabel="关闭" onOpenChange={onOpenChange}>
        <button type="button">字段</button>
      </DialogShell>,
    );
    const dialog = await screen.findByRole("dialog", { name: "说明" });
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "字段" }));
    pressBackdrop();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("form 对话框默认没有右上角关闭；Esc 仍可取消", async () => {
    const onOpenChange = vi.fn();
    render(
      <DialogShell open purpose="form" title="保存位置" onOpenChange={onOpenChange}>
        <button type="button">字段</button>
      </DialogShell>,
    );
    await screen.findByRole("dialog", { name: "保存位置" });
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    pressBackdrop();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("required 对话框拦截 Esc，必须明确响应", async () => {
    const onOpenChange = vi.fn();
    render(
      <DialogShell open purpose="required" title="必须选择" onOpenChange={onOpenChange}>
        内容
      </DialogShell>,
    );
    await screen.findByRole("dialog", { name: "必须选择" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "必须选择" })).toBeTruthy();
  });

  it("autoHeight 显式打开时才包 DialogHeight", async () => {
    render(
      <DialogShell open purpose="form" title="向导" autoHeight onOpenChange={() => {}}>
        内容
      </DialogShell>,
    );
    const dialog = await screen.findByRole("dialog", { name: "向导" });
    expect(dialog.querySelector(".k-dialog-height")).toBeTruthy();
  });

  it("支持无可见标题、仅通过 aria-label 提供无障碍标题", async () => {
    render(
      <DialogShell open purpose="form" aria-label="标签的外部对应" onOpenChange={() => {}}>
        内容
      </DialogShell>,
    );
    const dialog = await screen.findByRole("dialog", { name: "标签的外部对应" });
    expect(dialog.querySelector(".k-title")).toBeNull();
    expect(dialog.getAttribute("aria-label")).toBe("标签的外部对应");
  });

  it("busy 时阻止 Esc、点遮罩与右上角关闭", async () => {
    const onOpenChange = vi.fn();
    render(
      <DialogShell open purpose="info" busy title="正在保存" closeLabel="关闭" onOpenChange={onOpenChange}>
        内容
      </DialogShell>,
    );
    await screen.findByRole("dialog", { name: "正在保存" });
    const closeButton = screen.getByRole("button", { name: "关闭" });
    expect(closeButton.hasAttribute("disabled")).toBe(true);
    pressBackdrop();
    fireEvent.click(closeButton);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "正在保存" })).toBeTruthy();
  });

  it("form 对话框在 busy 时拦截 Esc，解除 busy 后恢复可关闭", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <DialogShell open purpose="form" busy title="保存位置" onOpenChange={onOpenChange}>
        内容
      </DialogShell>,
    );
    await screen.findByRole("dialog", { name: "保存位置" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <DialogShell open purpose="form" busy={false} title="保存位置" onOpenChange={onOpenChange}>
        内容
      </DialogShell>,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("AlertDialog 骨架", () => {
  it("没有右上角关闭，初始焦点强制落在取消按钮", async () => {
    render(<AlertSample />);
    await screen.findByRole("alertdialog", { name: "永久删除" });
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" })));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "删除" }));
  });

  it("Esc 仍走取消语义", async () => {
    const onOpenChange = vi.fn();
    render(<AlertSample onOpenChange={onOpenChange} />);
    await screen.findByRole("alertdialog", { name: "永久删除" });
    pressBackdrop();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("busy 时拦截 Esc 取消", async () => {
    const onOpenChange = vi.fn();
    render(<AlertSample busy onOpenChange={onOpenChange} />);
    await screen.findByRole("alertdialog", { name: "永久删除" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
