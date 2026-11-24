import { memo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Candidate } from "../bindings/Candidate";
import type { SearchInput } from "../bindings/SearchInput";
import type { TagLabel } from "../bindings/TagLabel";
import { SaveDestinationProvider, useSaveDestination } from "../library/SaveDestination";
import { fakeBackend } from "../test/backend";
import { SearchBox } from "./SearchBox";
import * as fitChips from "./fitChips";

const emptyInput: SearchInput = { conditions: [], exact: false };
const oneConditionInput: SearchInput = {
  conditions: [{ any: [{ kind: "text", text: "蓝", dismissed: [] }], negate: false }],
  exact: false,
};
const sampleTag: TagLabel = {
  id: "t-abc",
  name: "蓝发",
  namespace: "general",
  untranslated: false,
  hasExternal: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SearchBox 与 SaveDestinationProvider 性能", () => {
  it("空条件时不调用 chipsThatFit，有条件时无关重渲染不重复测量", () => {
    fakeBackend();
    const spy = vi.spyOn(fitChips, "chipsThatFit").mockReturnValue(Infinity);

    function Harness({ input }: { input: SearchInput }) {
      const [unrelated, setUnrelated] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setUnrelated((n) => n + 1)}>
            {unrelated}
          </button>
          <SearchBox
            workspace
            libraryId="workspace"
            safe={false}
            generation={1}
            input={input}
            tree={null}
            showSource={false}
            onChange={() => {}}
            onError={() => {}}
          />
        </div>
      );
    }

    const { rerender } = render(<Harness input={emptyInput} />);
    expect(spy).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByRole("button", { name: "0" }));
    expect(spy).toHaveBeenCalledTimes(0);

    rerender(<Harness input={oneConditionInput} />);
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("连续快速击键合并为一次候选请求，清空输入立即隐藏候选且不发请求", async () => {
    vi.useFakeTimers();
    const candidate: Candidate = { tag: sampleTag, via: null, count: 1 };
    const fake = fakeBackend({
      workspace_candidates: [candidate],
      rating_candidates: [],
    });

    render(
      <SearchBox
        workspace
        libraryId="workspace"
        safe={false}
        generation={1}
        input={emptyInput}
        tree={null}
        showSource={false}
        onChange={() => {}}
        onError={() => {}}
      />,
    );

    const input = screen.getByRole("combobox", { name: "查找参考图" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fake.calls("workspace_candidates")).toHaveLength(0);
    expect(fake.calls("rating_candidates")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(fake.calls("workspace_candidates")).toHaveLength(1);
    expect(fake.calls("workspace_candidates")[0]?.args).toMatchObject({ text: "abc" });
    expect(fake.calls("rating_candidates")).toHaveLength(1);
    expect(fake.calls("rating_candidates")[0]?.args).toMatchObject({ text: "abc" });
    expect(screen.getByRole("option", { name: /蓝发/ })).toBeTruthy();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("option", { name: /蓝发/ })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fake.calls("workspace_candidates")).toHaveLength(1);
    expect(fake.calls("rating_candidates")).toHaveLength(1);
  });

  it("SaveDestinationProvider 在无关状态变更时保持 Context 引用稳定", async () => {
    fakeBackend({
      workspace_directories: {
        status: { revision: "r1", libraries: [] },
        providers: [],
        registrationOrder: [],
      },
      save_memory: {
        importDestination: null,
        newLibraryParent: null,
        pixivDestination: null,
        subscriptionDestination: null,
      },
    });

    let consumerRenders = 0;
    const Consumer = memo(function Consumer() {
      const { ready } = useSaveDestination();
      consumerRenders += 1;
      return <span>{ready ? "ready" : "loading"}</span>;
    });

    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            tick-{tick}
          </button>
          <SaveDestinationProvider safe={true}>
            <Consumer />
          </SaveDestinationProvider>
        </div>
      );
    }

    render(<Harness />);
    await screen.findByText("ready");
    const rendersAtReady = consumerRenders;

    fireEvent.click(screen.getByRole("button", { name: "tick-0" }));
    fireEvent.click(screen.getByRole("button", { name: "tick-1" }));
    expect(consumerRenders).toBe(rendersAtReady);
  });
});
