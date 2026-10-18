import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it } from "vitest";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { RatingCandidate } from "../bindings/RatingCandidate";
import type { SearchInput } from "../bindings/SearchInput";
import type { TagLabel } from "../bindings/TagLabel";
import { SearchBox } from "./SearchBox";

afterEach(() => {
  cleanup();
  clearMocks();
});

const shortHair: TagLabel = { id: "t-short", name: "短发", namespace: "general", untranslated: false, hasExternal: true };
const r18: RatingCandidate = { rating: { ratings: ["questionable", "explicit"], name: "R18" }, via: null };
const empty: SearchInput = { conditions: [], exact: false };

function backend(ratingCandidates: RatingCandidate[]) {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith("|search_candidates")) return [{ tag: shortHair, via: null, count: 3 }];
    if (cmd.endsWith("|rating_candidates")) return ratingCandidates;
    return undefined;
  });
  return calls;
}

function box(props: { input?: SearchInput; tree?: ConditionTree | null; safe?: boolean; onChange?: (input: SearchInput) => void }) {
  return render(
    <SearchBox
      libraryId="L1"
      safe={props.safe ?? false}
      generation={1}
      input={props.input ?? empty}
      tree={props.tree ?? null}
      showSource={false}
      onChange={props.onChange ?? (() => {})}
      onError={(e) => {
        throw Error(e);
      }}
    />,
  );
}

it("输入 R18 时下拉里有一个标明是分级的合并候选，点选后成为分级条件", async () => {
  const calls = backend([r18]);
  const changes: SearchInput[] = [];
  box({ onChange: (input) => changes.push(input) });
  const input = screen.getByRole("combobox", { name: "查找参考图" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "R18" } });

  const option = await screen.findByRole("option", { name: /分级.*R18/ });
  expect(within(option).getByText("分级")).toBeTruthy();
  expect(calls.find((c) => c.cmd.endsWith("|rating_candidates"))?.args).toEqual({ text: "R18", safeMode: false });
  // 标签候选与分级候选同时列出。
  expect(screen.getByRole("option", { name: /短发/ })).toBeTruthy();

  fireEvent.click(option);
  expect(changes).toEqual([
    { conditions: [{ any: [{ kind: "rating", ratings: ["questionable", "explicit"] }], negate: false }], exact: false },
  ]);
});

it("分级候选可以放进上一个条件，作为“任一”", async () => {
  backend([r18]);
  const changes: SearchInput[] = [];
  const input: SearchInput = { conditions: [{ any: [{ kind: "tag", id: shortHair.id, dismissed: [] }], negate: false }], exact: false };
  box({ input, onChange: (value) => changes.push(value) });
  const field = screen.getByRole("combobox", { name: "查找参考图" });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: "R18" } });

  fireEvent.click(await screen.findByRole("option", { name: /分级.*R18/ }), { ctrlKey: true });
  expect(changes.at(-1)).toEqual({
    conditions: [
      {
        any: [
          { kind: "tag", id: shortHair.id, dismissed: [] },
          { kind: "rating", ratings: ["questionable", "explicit"] },
        ],
        negate: false,
      },
    ],
    exact: false,
  });
});

it("条件里的分级标明是分级，可以排除", () => {
  backend([]);
  const changes: SearchInput[] = [];
  const input: SearchInput = {
    conditions: [{ any: [{ kind: "rating", ratings: ["questionable", "explicit"] }], negate: false }],
    exact: false,
  };
  const tree: ConditionTree = { conditions: [{ any: [{ kind: "rating", rating: r18.rating }], negate: false }] };
  box({ input, tree, onChange: (value) => changes.push(value) });

  const chip = within(screen.getByRole("list", { name: "查找条件" })).getByRole("listitem");
  expect(chip.textContent).toContain("分级");
  expect(chip.textContent).toContain("R18");
  fireEvent.click(within(chip).getByRole("button", { name: "排除这个条件" }));
  expect(changes).toEqual([{ conditions: [{ ...input.conditions[0], negate: true }], exact: false }]);
});

it("安全模式开着时按开着的视角取分级候选，后端不给的成人分级不出现", async () => {
  const calls = backend([]);
  box({ safe: true });
  const field = screen.getByRole("combobox", { name: "查找参考图" });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: "R18" } });

  await screen.findByRole("option", { name: /短发/ });
  await waitFor(() => expect(calls.find((c) => c.cmd.endsWith("|rating_candidates"))?.args).toEqual({ text: "R18", safeMode: true }));
  expect(screen.queryByRole("option", { name: /分级/ })).toBeNull();
});
