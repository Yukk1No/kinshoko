import { expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { setMedia } from "../test/platform";
import { useReducedMotion } from "./reducedMotion";

function Probe() { return <span>{useReducedMotion() ? "reduced" : "full"}</span>; }

it("系统设置的减弱动效切换后立即生效（#180）", () => {
  render(<Probe />);
  expect(screen.getByText("full")).toBeTruthy();
  act(() => setMedia("(prefers-reduced-motion: reduce)", true));
  expect(screen.getByText("reduced")).toBeTruthy();
  act(() => setMedia("(prefers-reduced-motion: reduce)", false));
  expect(screen.getByText("full")).toBeTruthy();
});
