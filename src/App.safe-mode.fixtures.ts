import { screen } from "@testing-library/react";
import { push } from "./App.fixtures";

export const safeModeButton = () => screen.findByRole("button", { name: /安全模式/ });
export const cardOf = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`);
export const safeModeChanged = (on: boolean) => push({ kind: "safeModeChanged", libraryId: "L1", on });
