import { expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceSources } from "./WorkspacePane";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import { type Args, fakeBackend } from "../test/backend";
import { tipText } from "../test/tip";

const card: WorkspaceCard = { id: "same-bytes", width: 100, height: 200, adult: false, libraryId: "A", imageId: "a", sources: [
  { libraryId: "A", libraryName: "工作参考", imageId: "a", matches: true, unavailable: null, deleted: false },
  { libraryId: "B", libraryName: "移动盘参考", imageId: "b", matches: true, unavailable: null, deleted: false },
] };
/** 一份来源的详情；`detail` 改写其中的字段。 */
function imageDetail(id: string, detail: (id: string) => object = () => ({})) {
  return { id, originalName: id + ".png", width: 100, height: 200, folders: [], note: { manual: id + " 的备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: id, suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] }, ...detail(id) };
}

/** 一份来源的读取（#424）：详情与标签。 */
function sourceReads(detail: (id: string) => object = () => ({})) {
  return {
    image: (args: Args) => imageDetail(args.imageId as string, detail),
    catalog_image_tags: (args: Args) => ({ image: { imageId: args.imageId as string, tags: [], rejected: [] }, identities: [] }),
  };
}

/** 一直没有回答的请求。 */
const hang = () => new Promise(() => {});

it("切到另一份后，备注按（资料库，图）只写那一份", async () => {
  const edits: unknown[] = [];
  fakeBackend({
    ...sourceReads((id) => ({ note: { manual: id === "b" ? "B 的备注" : "A 的备注", sources: [] } })),
    reference_groups: [],
    edit: (args) => { edits.push(args); return []; },
  });
  render(<WorkspaceSources card={card} onClose={vi.fn()} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("B 的备注"));
  const note = screen.getByRole("textbox", { name: "备注" });
  fireEvent.change(note, { target: { value: "只改 B" } });
  fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
  await waitFor(() => expect(edits).toEqual([{ libraryId: "B", ids: ["b"], edits: [{ kind: "setNote", text: "只改 B" }] }]));
});

it("换到 B 后，A 迟到的分级响应不能关闭 B 的面板", async () => {
  let finish!: (details: unknown[]) => void;
  const pending = new Promise<unknown[]>((resolve) => { finish = resolve; });
  fakeBackend({ ...sourceReads(), edit: () => pending });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: "成人" }));
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("b 的备注"));
  await act(async () => {
    finish([imageDetail("a", () => ({ rating: { imageId: "a", suggested: null, manual: "explicit", effective: "explicit" } }))]);
    await pending;
  });
  expect(close).not.toHaveBeenCalled();
});

it("安全模式下把这一份改成成人分级，面板随之关闭", async () => {
  fakeBackend({
    ...sourceReads(),
    edit: [imageDetail("a", () => ({ rating: { imageId: "a", suggested: null, manual: "explicit", effective: "explicit" } }))],
  });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: "成人" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it("同名图库在切换按钮的提示里显示最短独立路径", async () => {
  const sameNames = { ...card, sources: card.sources.map((source) => ({ ...source, libraryName: "同名资料库" })) };
  fakeBackend({ image: hang, catalog_image_tags: hang });
  render(<WorkspaceSources card={sameNames} onClose={vi.fn()} registrations={[
    { library: { id: "A", name: "同名资料库", root: "C:\\common\\first\\Art" }, unavailable: null },
    { library: { id: "B", name: "同名资料库", root: "C:\\common\\second\\Art" }, unavailable: null },
  ]} />);
  const [a, b] = within(screen.getByRole("group", { name: "所在图库" })).getAllByRole("button");
  expect(await tipText(a)).toBe("…\\first\\Art");
  expect(await tipText(b)).toBe("…\\second\\Art");
});

it("只在一个图库的图直接显示详情，没有图库切换", async () => {
  fakeBackend(sourceReads(() => ({ originalName: "only.png" })));
  render(<WorkspaceSources card={{ ...card, sources: card.sources.slice(0, 1) }} onClose={vi.fn()} />);
  await screen.findByText("only.png");
  expect(screen.queryByRole("group", { name: "所在图库" })).toBeNull();
});

it("卡片代表的那份未连接时，先打开另一份可用的", async () => {
  const inspected: string[] = [];
  fakeBackend({
    image: (args) => { inspected.push(args.libraryId as string); return hang(); },
    catalog_image_tags: hang,
  });
  const offline: WorkspaceCard = { ...card, sources: [{ ...card.sources[0], unavailable: { code: "system", detail: "离线" } }, card.sources[1]] };
  render(<WorkspaceSources card={offline} onClose={vi.fn()} />);
  await waitFor(() => expect(inspected).toEqual(["B"]));
});

it("来源读不出来时只留原因，收起面板", async () => {
  fakeBackend({ ...sourceReads(), image: () => Promise.reject({ code: "unknownImage" }) });
  render(<WorkspaceSources card={{ ...card, sources: card.sources.slice(0, 1) }} onClose={vi.fn()} />);
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  expect(screen.queryByRole("textbox", { name: "备注" })).toBeNull();
});

it("和普通单选面板一样：没有操作栏，文件夹标签不能移出", async () => {
  fakeBackend(sourceReads(() => ({ deletedAt: 1, folders: [{ id: "f", name: "人物" }] })));
  render(<WorkspaceSources card={card} onClose={vi.fn()} />);
  await screen.findByText("人物");
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(screen.queryByText("已选 1 张")).toBeNull();
  for (const name of ["移到文件夹", "移到回收站", "恢复", "永久删除…", "取消选择", "移出「人物」", "复制到…"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
});
