import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Candidate } from "./bindings/Candidate";
import type { SearchInput } from "./bindings/SearchInput";
import { App } from "./App";
import {
  library,
  label,
  candidates,
  resolved,
  clean,
  safeOn,
  backend,
  LocalSearchFixture,
  sent,
  push,
} from "./App.fixtures";
import type { Args } from "./test/backend";
import { cardOf, safeModeButton as book, safeModeChanged as changed } from "./App.safe-mode.fixtures";

describe("安全模式", () => {
  describe("候选随视角作废（#76）", () => {
    const adult: Candidate = { tag: label("ADULT", "general", "只在成人图出现的标签"), via: null, count: 1 };
    const box = () => screen.findByRole("combobox", { name: "查找参考图" });
    /** 后端核对请求带的视角：与资料库的安全模式不同时拒绝，与真实命令一致。 */
    const lensChecked = (hold?: () => Promise<Candidate[]> | undefined) => ({
      workspace_candidates: (args: Args) => {
        const { text, safeMode } = args as { text: string; safeMode: boolean };
        const held = hold?.();
        if (held) return held;
        if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
        return text.trim() && !safeOn ? [adult] : [];
      },
    });

    it.each(["封印书", "快捷键"])(
      "用%s开启安全模式时立即清掉成人图独有的候选与数量，重新聚焦也不再出现",
      async (entry) => {
        backend(library, clean, lensChecked(), false);
        render(<App />);
        await waitFor(() => expect(cardOf("x")).toBeTruthy());
        const input = await box();
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: "只在成人" } });
        expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

        if (entry === "封印书") fireEvent.click(await book());
        else fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
        // 不等后端确认，也不用再打字。
        expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
        expect(document.querySelector(".k-option .k-item-meta")).toBeNull();

        await changed(true);
        fireEvent.blur(input);
        fireEvent.focus(input);
        await waitFor(() =>
          expect(sent("workspace_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }),
        );
        expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
      },
    );

    it("切换前发出的候选请求迟到时不写回新视角", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => {
        finish = resolve;
      });
      let first = true;
      backend(
        library,
        clean,
        lensChecked(() => {
          if (!first) return undefined;
          first = false;
          return late;
        }),
        false,
      );
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("workspace_candidates")).toHaveLength(1));
      fireEvent.click(await book());
      await changed(true);
      await act(async () => {
        finish([adult]);
        await late;
      });
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("关闭后候选按新视角重新取得，再开启时又立即清掉", async () => {
      backend(library, clean, lensChecked());
      render(<App />);
      await screen.findAllByRole("img");
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("workspace_candidates")).toHaveLength(1));
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();

      fireEvent.click(await book());
      await changed(false);
      expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

      fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("词表变化后重新取得候选", async () => {
      let names = ["旧名"];
      backend(library, clean, {
        workspace_candidates: () => names.map((name) => ({ tag: label(name, "general", name), via: null, count: 1 })),
      });
      render(<App />);
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "名" } });
      expect(await screen.findByRole("option", { name: /旧名/ })).toBeTruthy();
      names = ["新名"];
      await push({ kind: "vocabularyChanged", libraryId: "L1", revision: 9 });
      expect(await screen.findByRole("option", { name: /新名/ })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /旧名/ })).toBeNull();
    });

    it("“加相近标签”的候选同样随视角作废，迟到的响应不写回", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => {
        finish = resolve;
      });
      let holding = false;
      backend(
        library,
        clean,
        {
          search_candidates: (args: Args) => {
            const { text, safeMode } = args as { text: string; safeMode: boolean };
            if (text === "只在成人" && holding) {
              holding = false;
              return late;
            }
            if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
            if (text === "只在成人") return safeOn ? [] : [adult];
            return text.trim() ? candidates : [];
          },
        },
        false,
      );
      render(<LocalSearchFixture />);
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const dialog = await screen.findByRole("dialog", { name: "加相近标签" });
      const pick = within(dialog).getByRole("combobox", { name: "挑本图库的标签" });
      fireEvent.change(pick, { target: { value: "只在成人" } });
      expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      await changed(true);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const safeDialog = await screen.findByRole("dialog", { name: "加相近标签" });
      fireEvent.change(within(safeDialog).getByRole("combobox"), { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("search_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }));
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();

      // An unsafe request may finish after its dialog and lens have been revoked.
      holding = true;
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(false);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      fireEvent.change(within(await screen.findByRole("dialog", { name: "加相近标签" })).getByRole("combobox"), {
        target: { value: "只在成人" },
      });
      await waitFor(() => expect(holding).toBe(false));
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(true);
      await act(async () => {
        finish([adult]);
        await late;
      });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("条件解析带上当前视角，视角刚切换的拒绝不当作错误显示", async () => {
      backend(
        library,
        clean,
        {
          workspace_resolve: (args: Args) => {
            const { input, safeMode } = args as { input: SearchInput; safeMode: boolean };
            if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
            return resolved(input);
          },
        },
        false,
      );
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      await waitFor(() => expect(sent("workspace_resolve").at(-1)).toMatchObject({ safeMode: false }));
      fireEvent.click(await book());
      await waitFor(() => expect(sent("workspace_resolve").at(-1)).toMatchObject({ safeMode: true }));
      await changed(true);
      await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("水色发"));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
