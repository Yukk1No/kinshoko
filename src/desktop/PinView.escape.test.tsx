// Supplemental frontend boundary check for #79; native WebView2 verification is separate.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, expect, it } from "vitest";
import { PinView } from "./PinView";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); });

it("Esc closes the active pin while another pin remains open", async () => {
  const open = new Set(["P1", "P2"]);
  mockWindows("pin-P1");
  mockIPC((command, args) => {
    if (command === "plugin:desktop|close_pin") open.delete((args as { pin: string }).pin);
    return null;
  }, { shouldMockEvents: true });
  render(<PinView pin="P1" />);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect([...open]).toEqual(["P2"]));
});
