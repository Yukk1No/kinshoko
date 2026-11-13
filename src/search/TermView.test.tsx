import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Term } from "../bindings/Term";
import { TermView } from "./TermView";

const label = (id: string, name: string) => ({
  id,
  namespace: "general" as const,
  name,
  untranslated: false,
  hasExternal: true,
});
const blue: Term = {
  kind: "tag",
  tag: label("blue", "蓝瞳"),
  similar: [{ tag: label("aqua", "水色瞳"), source: "builtin", of: ["blue"] }],
};
const view = (brief: boolean) =>
  render(
    <span data-testid="term">
      <TermView
        term={blue}
        showSource={false}
        brief={brief}
        dismiss={(_, button) => button}
        add={(_, button) => button}
      />
    </span>,
  );

afterEach(cleanup);

describe("条件里的一项", () => {
  it("单独一项时列出相近标签，可以关掉、可以加", () => {
    const { getByTestId, getAllByRole } = view(false);
    expect(getByTestId("term").textContent).toContain("蓝瞳或相近：水色瞳");
    expect(getAllByRole("button")).toHaveLength(2);
  });

  it("几项任一时只列标签名，不列相近标签", () => {
    const { getByTestId, queryAllByRole } = view(true);
    expect(getByTestId("term").textContent).toBe("蓝瞳");
    expect(queryAllByRole("button")).toHaveLength(0);
  });
});
