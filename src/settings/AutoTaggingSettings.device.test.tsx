import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { ModelChoice } from "../bindings/ModelChoice";
import { chooseOption } from "../test/select";
import { AutoTaggingSettings } from "./AutoTaggingSettings";
import { backend, choice, hardware, running, statusRow } from "./AutoTaggingSettings.fixtures";

describe("remembered tagging session device", () => {
  it("keeps a GPU name only while loading another GPU session", async () => {
    backend({ status: { ...running, device: "directMl", gpu: "RX 6500 XT" } });
    render(<AutoTaggingSettings hasLibrary />);
    await screen.findByText("自动：当前用显卡（RX 6500 XT）");
    await act(async () => {});
    await act(() => emit("tagging-status", { state: "starting", device: "directMl" }));
    expect(screen.getByText("自动：当前用显卡（RX 6500 XT）")).toBeTruthy();
    await act(() => emit("tagging-status", { state: "starting", device: "cpu" }));
    expect(screen.getByText("自动：当前用 CPU")).toBeTruthy();
    await act(() => emit("tagging-status", { state: "starting", device: "directMl" }));
    expect(screen.getByText("自动：当前用显卡")).toBeTruthy();
  });

  it("forgets the device while preparing a different model", async () => {
    backend({ status: running });
    render(<AutoTaggingSettings hasLibrary />);
    await screen.findByText("自动：当前用 CPU");
    await act(async () => {});
    await act(() => emit("tagging-status", { state: "preparing", model: "another model" }));
    expect(screen.getByText("自动：有独显时用显卡")).toBeTruthy();
    await act(() => emit("tagging-status", { state: "paused" }));
    expect(screen.getByText("自动：有独显时用显卡")).toBeTruthy();
    expect(within(statusRow()).getByText("已暂停，还剩 138 张")).toBeTruthy();
  });

  it.each([false, true])("uses the next session device after switching to automatic (paused: %s)", async (paused) => {
    let selected: ModelChoice["selected"] = "cpu";
    backend({
      status: running,
      replies: {
        tagging_models: () => ({ ...choice, selected }),
        tagging_set_device: ({ device }) => {
          selected = device as ModelChoice["selected"];
          return { ...choice, selected };
        },
        tagging_resume: null,
      },
    });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(async () => expect((await hardware()).textContent).toMatch(/^CPU/));
    await chooseOption(await hardware(), "自动");
    await screen.findByText("自动：有独显时用显卡");
    await act(() => emit("tagging-status", { ...running, tagged: 6 }));
    expect(screen.getByText("自动：当前用 CPU")).toBeTruthy();
    if (paused) {
      await act(() => emit("tagging-status", { state: "paused" }));
      fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    }
    await act(() => emit("tagging-status", { state: "starting", device: "directMl" }));
    expect(screen.queryByText("自动：当前用 CPU")).toBeNull();
    expect(screen.getByText("自动：当前用显卡")).toBeTruthy();
  });
});
