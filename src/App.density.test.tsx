import { expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { backend, clean, library } from "./App.fixtures";
import { shellSettings, type Args } from "./test/backend";

it("keeps the latest wall size when an earlier settings write returns", async () => {
  let finishSetting!: () => void;
  let finishDensity!: () => void;
  const saveDensity = vi.fn(
    (args: Args) =>
      new Promise((resolve) => {
        finishDensity = () => resolve(shellSettings({ wallDensity: args.density as number }));
      }),
  );
  backend(library, clean, {
    shell_settings: () => shellSettings(),
    "change_setting:autostart": () =>
      new Promise((resolve) => {
        finishSetting = () => resolve(shellSettings({ autostart: true }));
      }),
    "change_setting:wallDensity": saveDensity,
  });
  render(<App />);
  await screen.findAllByRole("img");
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(await screen.findByRole("switch", { name: "开机启动" }));
  await waitFor(() => expect(finishSetting).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  const slider = () => screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement;
  fireEvent.change(slider(), { target: { value: "330" } });
  fireEvent.pointerUp(slider());
  expect(saveDensity).not.toHaveBeenCalled();
  await act(async () => finishSetting());
  expect(slider().value).toBe("330");
  await waitFor(() => expect(saveDensity).toHaveBeenCalledTimes(1));
  await act(async () => finishDensity());
  expect(slider().value).toBe("330");
});

it("writes wall density once per drag and remembers it when the main window is recreated", async () => {
  let density = 240;
  const saveDensity = vi.fn((args: Args) => {
    density = args.density as number;
    return shellSettings({ wallDensity: density });
  });
  backend(library, clean, {
    shell_settings: () => shellSettings({ wallDensity: density }),
    "change_setting:wallDensity": saveDensity,
  });
  render(<App />);
  await screen.findAllByRole("img");
  const slider = () => screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement;
  fireEvent.pointerDown(slider());
  fireEvent.change(slider(), { target: { value: "270" } });
  fireEvent.change(slider(), { target: { value: "300" } });
  fireEvent.change(slider(), { target: { value: "330" } });
  expect(slider().value).toBe("330");
  await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  expect(saveDensity).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider());
  await waitFor(() => expect(density).toBe(330));
  fireEvent.blur(slider());
  expect(saveDensity).toHaveBeenCalledTimes(1);
  cleanup();
  expect(saveDensity).toHaveBeenCalledTimes(1);
  render(<App />);
  await waitFor(() => expect(slider().value).toBe("330"));
});
