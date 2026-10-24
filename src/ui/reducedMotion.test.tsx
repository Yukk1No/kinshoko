import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useReducedMotion } from "./reducedMotion";

afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-reduced-motion"); });

function Probe() { return <span>{useReducedMotion() ? "reduced" : "full"}</span>; }

it("根元素上的减少动画标记切换后立即生效（#180）", async () => {
  render(<Probe />);
  expect(screen.getByText("full")).toBeTruthy();
  await act(async () => { document.documentElement.setAttribute("data-reduced-motion", ""); });
  expect(screen.getByText("reduced")).toBeTruthy();
  await act(async () => { document.documentElement.removeAttribute("data-reduced-motion"); });
  expect(screen.getByText("full")).toBeTruthy();
});
