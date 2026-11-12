// 右下角图标在有图没有完成自动标签时（#475）：常驻提示、点击重试、右键查看与忽略。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { TaggingActivity } from "./TaggingActivity";
import { fakeBackend, type FakeBackend } from "./test/backend";

let fake: FakeBackend;
/** 前端发出的命令，按先后。 */
const actions = () => fake.calls();

function backend(status: TaggingStatus) {
  fake = fakeBackend({ tagging_status: status, tagging_retry_failed: null });
}

const push = (status: TaggingStatus) => act(() => emit("tagging-status", status));
const mount = () => render(<TaggingActivity onOpenSettings={vi.fn()} />);
const idle = (tagged: number): TaggingStatus => ({ state: "idle", model: "PixAI", device: "directMl", gpu: "RX 6500 XT", tagged, unknown: 0, failed: { unreadable: 0, crashed: 0 } });
const settled = () => waitFor(() => expect(actions().some((a) => a.command === "tagging_status")).toBe(true));


describe("没有完成的图（#475）", () => {
  const unfinished = (unreadable: number, crashed: number): TaggingStatus => ({ ...idle(0), failed: { unreadable, crashed } } as TaggingStatus);
  const retryIcon = () => screen.queryByRole("button", { name: /重试没有完成的图/ });
  afterEach(() => localStorage.clear());

  it("常驻提示图标，写出张数与原因；点击重试", async () => {
    backend(unfinished(2, 1));
    mount();
    const button = await screen.findByRole("button", { name: "重试没有完成的图：3 张没有完成，2 张无法读取，1 张出错" });
    expect(button.dataset.activity).toBe("unfinished");
    fireEvent.click(button);
    await waitFor(() => expect(actions().some((a) => a.command === "tagging_retry_failed")).toBe(true));
  });

  it("只有一类时只写这一类", async () => {
    backend(unfinished(0, 1));
    mount();
    await screen.findByRole("button", { name: "重试没有完成的图：1 张没有完成，1 张出错" });
  });

  it("右键查看这些图", async () => {
    backend(unfinished(1, 0));
    const onShowUnfinished = vi.fn();
    render(<TaggingActivity onOpenSettings={() => {}} onShowUnfinished={onShowUnfinished} />);
    const button = await screen.findByRole("button", { name: /重试没有完成的图/ });
    fireEvent.contextMenu(button, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "查看这些图" }));
    expect(onShowUnfinished).toHaveBeenCalledTimes(1);
  });

  it("忽略后收起，下次启动也不显示；之后再多出没有完成的图才再显示", async () => {
    backend(unfinished(1, 1));
    const first = mount();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /重试没有完成的图/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "忽略" }));
    await waitFor(() => expect(retryIcon()).toBeNull());
    first.unmount();

    mount();
    await settled();
    await act(async () => {});
    expect(retryIcon()).toBeNull();
    await push(unfinished(2, 1));
    await screen.findByRole("button", { name: /3 张没有完成/ });
  });

  it("重试后张数变少，再出现时照常显示", async () => {
    backend(unfinished(2, 0));
    mount();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /重试没有完成的图/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "忽略" }));
    await waitFor(() => expect(retryIcon()).toBeNull());
    await push(unfinished(0, 0));
    await push(unfinished(1, 0));
    await screen.findByRole("button", { name: /1 张没有完成/ });
  });
});

