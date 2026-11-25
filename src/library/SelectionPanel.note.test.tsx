import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageRating } from "../bindings/ImageRating";
import { SelectionPanel } from "./SelectionPanel";
import { fakeBackend } from "../test/backend";

const NO_TAGS = { image: { imageId: "img", tags: [], rejected: [] }, identities: [] };

function detail(rating: Partial<ImageRating>): ImageDetail {
  return {
    id: "img",
    originalName: "img.png",
    width: 10,
    height: 10,
    folders: [],
    note: { manual: null, sources: [] },
    deletedAt: null,
    collectedAt: 0,
    sourceLinks: [],
    versions: { previous: null, newer: [] },
    taggingFailure: null,
    rating: { imageId: "img", suggested: "explicit", manual: null, effective: "explicit", ...rating },
  };
}

function renderPanel() {
  render(
    <SelectionPanel libraryId="L1" selected={new Set(["img"])} onClear={() => {}} reloadKey={0} onError={() => {}} />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("选中一张图：备注防丢与快捷保存（#717）", () => {
  function noteBackend(initial: Record<string, ImageDetail>) {
    const store = new Map(Object.entries(initial));
    const calls: Array<{ libraryId: string; ids: string[]; edits: unknown[] }> = [];
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: (args) => store.get(String(args.imageId))!,
      edit: (args) => {
        const { libraryId, ids, edits } = args as {
          libraryId: string;
          ids: string[];
          edits: Array<{ kind: string; text?: string }>;
        };
        calls.push({ libraryId, ids, edits });
        const id = ids[0];
        const prev = store.get(id)!;
        const set = edits.find((e) => e.kind === "setNote");
        const revert = edits.find((e) => e.kind === "revertNote");
        const updated = {
          ...prev,
          note: set ? { ...prev.note, manual: set.text ?? "" } : revert ? { ...prev.note, manual: null } : prev.note,
        };
        store.set(id, updated);
        return [updated];
      },
    });
    return calls;
  }

  it("Ctrl+Enter 立即保存备注且随后失焦不重复提交", async () => {
    const calls = noteBackend({ img: detail({}) });
    renderPanel();
    const box = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "注意透视" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(calls).toEqual([{ libraryId: "L1", ids: ["img"], edits: [{ kind: "setNote", text: "注意透视" }] }]),
    );
    fireEvent.blur(box);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });

  it("失焦时自动保存备注；点击改回来源备注触发失焦不抢先提交草稿", async () => {
    const withManual = { ...detail({}), note: { manual: "已有备注", sources: [{ text: "来源", source: "eagle" }] } };
    const calls = noteBackend({ img: withManual });
    renderPanel();
    const box = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;

    // 焦点移向同区块里的“改回来源备注”按钮，不触发 setNote；点击按钮走 revertNote。
    const revert = screen.getByRole("button", { name: "改回来源备注" });
    fireEvent.change(box, { target: { value: "临时草稿" } });
    fireEvent.blur(box, { relatedTarget: revert });
    fireEvent.click(revert);
    await waitFor(() => expect(calls).toEqual([{ libraryId: "L1", ids: ["img"], edits: [{ kind: "revertNote" }] }]));

    // 焦点移出备注区后自动提交改动。
    fireEvent.change(box, { target: { value: "新备注" } });
    fireEvent.blur(box);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ libraryId: "L1", ids: ["img"], edits: [{ kind: "setNote", text: "新备注" }] });
  });

  it("修改备注未点保存就切换到下一张图时，按原图的 libraryId 与 imageId 自动保存，绝不写到新图上", async () => {
    const imgA = { ...detail({}), id: "imgA", originalName: "A.png" };
    const imgB = { ...detail({}), id: "imgB", originalName: "B.png", note: { manual: "B 原备注", sources: [] } };
    const calls = noteBackend({ imgA, imgB });

    const panel = (id: string) => (
      <SelectionPanel libraryId="L1" selected={new Set([id])} onClear={() => {}} reloadKey={0} onError={() => {}} />
    );
    const view = render(panel("imgA"));
    const boxA = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(boxA, { target: { value: "A 的草稿" } });

    view.rerender(panel("imgB"));
    await waitFor(() =>
      expect(calls).toEqual([{ libraryId: "L1", ids: ["imgA"], edits: [{ kind: "setNote", text: "A 的草稿" }] }]),
    );
    await screen.findByText("B.png");
    expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("B 原备注");
  });

  it("备注保存失败后复位提交记录，再次点击保存或失焦均可重试成功", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    let failNext = true;
    let current = detail({});
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: () => current,
      edit: (args) => {
        const text = (args.edits as Array<{ kind: string; text?: string }>)[0]?.text ?? "";
        calls.push(text);
        if (failNext) {
          failNext = false;
          return Promise.reject("写入失败");
        }
        current = { ...current, note: { ...current.note, manual: text } };
        return [current];
      },
    });
    render(
      <SelectionPanel
        libraryId="L1"
        selected={new Set(["img"])}
        onClear={() => {}}
        reloadKey={0}
        onError={(e) => errors.push(e)}
      />,
    );

    const box = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "待重试备注" } });
    fireEvent.blur(box);
    await waitFor(() => expect(errors).toEqual(["写入失败"]));
    expect(calls).toEqual(["待重试备注"]);

    // 保存失败后再次点“保存”按钮，应能重新提交并成功。
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() => expect(calls).toEqual(["待重试备注", "待重试备注"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存备注" })).toBeNull());

    // 再次失败后，失焦也能自动重试。
    failNext = true;
    fireEvent.change(box, { target: { value: "第二次草稿" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(errors).toHaveLength(2));
    fireEvent.blur(box);
    await waitFor(() => expect(calls).toEqual(["待重试备注", "待重试备注", "第二次草稿", "第二次草稿"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存备注" })).toBeNull());
  });

  it("切图触发保存后切回原图以及保存期间 reloadKey 递增，均不会因过期 detailKey 锁死详情面板", async () => {
    const imgA = { ...detail({}), id: "imgA", originalName: "A.png" };
    const imgB = { ...detail({}), id: "imgB", originalName: "B.png" };
    const store = new Map<string, ImageDetail>([
      ["imgA", imgA],
      ["imgB", imgB],
    ]);
    const pending: Array<{ text: string; gate: ReturnType<typeof deferred<ImageDetail[]>> }> = [];
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: (args) => store.get(String(args.imageId))!,
      edit: (args) => {
        const id = (args.ids as string[])[0];
        const text = (args.edits as Array<{ kind: string; text?: string }>)[0]?.text ?? "";
        const gate = deferred<ImageDetail[]>();
        pending.push({ text, gate });
        const prev = store.get(id)!;
        const updated = { ...prev, note: { ...prev.note, manual: text } };
        store.set(id, updated);
        return gate.promise;
      },
    });

    const panel = (id: string, reloadKey: number) => (
      <SelectionPanel
        libraryId="L1"
        selected={new Set([id])}
        onClear={() => {}}
        reloadKey={reloadKey}
        onError={() => {}}
      />
    );
    const view = render(panel("imgA", 0));
    const boxA = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(boxA, { target: { value: "A草稿" } });

    // 切到 imgB 触发 stale 保存 imgA，但保存尚未返回时立刻切回 imgA。
    view.rerender(panel("imgB", 0));
    await waitFor(() => expect(pending).toHaveLength(1));
    view.rerender(panel("imgA", 0));
    await screen.findByText("A.png");

    pending[0].gate.resolve([store.get("imgA")!]);
    await waitFor(() => expect(document.querySelector(".selection-detail")?.getAttribute("aria-busy")).toBe("false"));
    expect(document.querySelector(".selection-detail")?.hasAttribute("inert")).toBe(false);

    // 保存期间 reloadKey 递增，旧请求返回后也不能把 loaded.key 倒退回旧版本。
    const boxAfter = screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement;
    fireEvent.change(boxAfter, { target: { value: "更新草稿" } });
    fireEvent.blur(boxAfter);
    await waitFor(() => expect(pending).toHaveLength(2));

    view.rerender(panel("imgA", 1));
    await waitFor(() => expect(document.querySelector(".selection-detail")?.getAttribute("aria-busy")).toBe("false"));
    pending[1].gate.resolve([store.get("imgA")!]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".selection-detail")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector(".selection-detail")?.hasAttribute("inert")).toBe(false);
  });

  it("Ctrl+Enter 保存未返回时继续输入不被旧响应覆盖，并发保存乱序返回也不回退草稿", async () => {
    const current = detail({});
    const pending: Array<{ text: string; gate: ReturnType<typeof deferred<ImageDetail[]>> }> = [];
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: () => current,
      edit: (args) => {
        const text = (args.edits as Array<{ kind: string; text?: string }>)[0]?.text ?? "";
        const gate = deferred<ImageDetail[]>();
        pending.push({ text, gate });
        return gate.promise;
      },
    });
    renderPanel();

    const box = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "第一段" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(pending).toHaveLength(1));

    // 请求尚未返回时继续输入，旧响应返回后不能冲掉新增内容。
    fireEvent.change(box, { target: { value: "第一段，第二段" } });
    pending[0].gate.resolve([{ ...current, note: { ...current.note, manual: "第一段" } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.value).toBe("第一段，第二段");
    expect(screen.getByRole("button", { name: "保存备注" })).toBeTruthy();

    // 连续两次提交并发乱序返回（后发先至、先发后至），草稿保持最新提交且不回退。
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.change(box, { target: { value: "第三段" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(pending).toHaveLength(3));

    pending[2].gate.resolve([{ ...current, note: { ...current.note, manual: "第三段" } }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存备注" })).toBeNull());
    pending[1].gate.resolve([{ ...current, note: { ...current.note, manual: "第一段，第二段" } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.value).toBe("第三段");
    expect(screen.queryByRole("button", { name: "保存备注" })).toBeNull();
  });

  it("跨图库切图时按旧图所属 libraryId 自动保存并正常上报失败，不与新 libraryId 错配", async () => {
    const imgA = { ...detail({}), id: "imgA", originalName: "A.png" };
    const imgB = { ...detail({}), id: "imgB", originalName: "B.png", note: { manual: "B 原备注", sources: [] } };
    const imgBGate = deferred<ImageDetail>();
    const calls: Array<{ libraryId: string; ids: string[]; edits: unknown[] }> = [];
    const errors: unknown[] = [];
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: (args) => (args.libraryId === "L1" ? imgA : imgBGate.promise),
      edit: (args) => {
        calls.push({
          libraryId: String(args.libraryId),
          ids: args.ids as string[],
          edits: args.edits as unknown[],
        });
        return Promise.reject("L1 已断开");
      },
    });

    const panel = (libraryId: string, id: string) => (
      <SelectionPanel
        libraryId={libraryId}
        selected={new Set([id])}
        onClear={() => {}}
        reloadKey={0}
        onError={(e) => errors.push(e)}
      />
    );
    const view = render(panel("L1", "imgA"));
    const boxA = (await screen.findByRole("textbox", { name: "备注" })) as HTMLTextAreaElement;
    fireEvent.change(boxA, { target: { value: "跨库草稿" } });

    // 切到 L2/imgB 且 L2/imgB 详情未到达前，应走 stale 路径按 L1/imgA 提交并正常向 onError 报出失败。
    view.rerender(panel("L2", "imgB"));
    await waitFor(() =>
      expect(calls).toEqual([{ libraryId: "L1", ids: ["imgA"], edits: [{ kind: "setNote", text: "跨库草稿" }] }]),
    );
    await waitFor(() => expect(errors).toEqual(["L1 已断开"]));

    imgBGate.resolve(imgB);
    await screen.findByText("B.png");
    expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("B 原备注");
  });
});
