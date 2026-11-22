import { expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { backend, clean, library } from "./App.fixtures";
import { shellSettings, type Args } from "./test/backend";

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
