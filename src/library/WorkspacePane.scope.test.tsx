import { expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkspacePane } from "./WorkspacePane";
import { registrations, forest, pending, props, settle, section, arrow, inA, loaded } from "./WorkspacePane.fixtures";

it("目录响应迟到时不替换新代次，当前范围保持明确身份", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = render(<WorkspacePane {...props} scope={selected} />);
  await settle();
  view.rerender(<WorkspacePane {...props} scope={selected} safeMode={false} reloadKey={1} status={{ ...props.status, revision: "new" }} />);
  await settle();
  const fresh = forest("new");
  fresh.providers[0].sidebar!.folders[0].name = "新目录";
  await act(async () => pending[1].resolve(fresh));
  await act(async () => pending[0].resolve(forest("old")));
  const a = section("A");
  expect(within(a).queryByRole("button", { name: "人物（2 张）" })).toBeNull();
  expect(within(a).getByRole("button", { name: "新目录（2 张）" })).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
  expect(pending[1].safeMode).toBe(false);
});

it("断连库与失效文件夹保持原范围并禁用旧目录控件", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = await loaded(render(<WorkspacePane {...props} scope={selected} />));
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={1} />);
  const gone = forest("gone");
  gone.providers[0].sidebar!.folders = [];
  await act(async () => pending[1].resolve(gone));
  expect(screen.getByText("范围：人物参考 / 文件夹已失效")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "含子文件夹" }).hasAttribute("data-disabled")).toBe(true);
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={2} />);
  const missing = forest("missing");
  missing.providers[0].registration.unavailable = "未连接";
  missing.providers[0].sidebar = null;
  await act(async () => pending[2].resolve(missing));
  expect(within(section("A")).getByRole("button", { name: "人物参考（未连接）" })).toHaveProperty("disabled", true);
  expect(screen.getByText("范围：人物参考 / 未连接")).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
});

it("读取时目录修订改变会自动重读，不留下要求用户操作的过期提示", async () => {
  render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />);
  await settle();
  await act(async () => pending[0].reject({ code: "cursorExpired" }));
  await settle();
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(forest("fresh")));
  expect(document.querySelectorAll("[data-folder-id]")).toHaveLength(2);
  expect(props.onError).not.toHaveBeenCalled();
});

it("未连接的图库名称变淡带警示点，同一行末尾就地重新连接，原因在悬停提示里（设计系统 v2）", async () => {
  const recheck = vi.fn();
  const missing = forest("offline");
  missing.providers[0].registration.unavailable = "资料库暂时不可用：移动盘没插";
  missing.providers[0].sidebar = null;
  await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} onRecheck={recheck} />), missing);
  const a = section("A");
  expect(a.getAttribute("data-offline")).toBe("true");
  expect(within(a).getByRole("button", { name: "人物参考（未连接）" })).toBeTruthy();
  expect(a.querySelector(".lib-dot.is-off")).toBeTruthy();
  // 不再另起一行说明：重新连接与图库名在同一行。
  expect(within(a).queryByRole("status")).toBeNull();
  const retry = within(a).getByRole("button", { name: "重新连接" });
  expect(retry.closest(".lib-head")).toBe(within(a).getByRole("button", { name: "人物参考（未连接）" }).closest(".lib-head"));
  expect(retry.title).toContain("移动盘没插");
  expect(within(a).queryByRole("button", { name: /^(展开|收起)/ })).toBeNull();
  fireEvent.click(retry);
  expect(recheck).toHaveBeenCalledTimes(1);
  expect(within(section("B")).queryByRole("button", { name: "重新连接" })).toBeNull();
});

it("回收站在侧栏底部跟随所选图库并显示库名", async () => {
  const two = forest(); two.providers[0].sidebar!.trash = 4; two.providers[1].sidebar!.trash = 2;
  const view = await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "folderTree", id: "A-root" })} />), two);
  const trash = screen.getAllByRole("button", { name: /^回收站/ });
  expect(trash).toHaveLength(1);
  expect(trash[0].closest(".side-foot")).toBeTruthy();
  expect(trash[0].getAttribute("aria-label")).toBe("回收站（人物参考，4 张）");
  fireEvent.click(trash[0]);
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "trash" } });
  view.rerender(<WorkspacePane {...props} scope={{ kind: "library", libraryId: "B", scope: { kind: "trash" } }} />);
  const shown = screen.getByRole("button", { name: /^回收站/ });
  expect(shown.getAttribute("aria-label")).toBe("回收站（风景参考，2 张）");
  expect(shown.getAttribute("aria-current")).toBe("page");
});

it("选“全部图片”时回收站显示各库合计，点开按库分组列出", async () => {
  const two = forest(); two.providers[0].sidebar!.trash = 4; two.providers[1].sidebar!.trash = 2;
  await loaded(undefined, two);
  const total = screen.getByRole("button", { name: "回收站（全部图库，6 张）" });
  expect(total.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(total);
  expect(total.getAttribute("aria-expanded")).toBe("true");
  const list = screen.getByRole("group", { name: "各图库的回收站" });
  expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["人物参考（4 张）", "风景参考（2 张）"]);
  fireEvent.click(within(list).getByRole("button", { name: "风景参考（2 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "B", scope: { kind: "trash" } });
});

it("只有一个已连接图库时，“全部图片”下的回收站直接打开它", async () => {
  const one = forest(); one.providers[0].sidebar!.trash = 1;
  one.providers[1].registration.unavailable = "未连接"; one.providers[1].sidebar = null;
  await loaded(undefined, one);
  fireEvent.click(screen.getByRole("button", { name: "回收站（全部图库，1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "trash" } });
});

it("导入期间列表过期只重读目录：资料库行与展开的文件夹沿用同一批 DOM 节点，只更新张数（#121）", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = await loaded(render(<WorkspacePane {...props} scope={selected} />));
  const head = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  const chevron = arrow("A");
  const folder = within(section("A")).getByRole("button", { name: "人物（2 张）" });
  // 导入进度推进时，每次列表过期 App 都给 reloadKey 加一，工作区状态的内容修订也随进库前进；
  // 目录响应到达前与到达后都不换节点，资料库行一直可用。
  for (let reload = 1; reload <= 3; reload++) {
    view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={reload} status={{ ...props.status, revision: `r${reload}` }} />);
    await settle();
    expect(section("A").contains(head)).toBe(true);
    expect(head).toHaveProperty("disabled", false);
    expect(section("A").contains(chevron) && section("A").contains(folder)).toBe(true);
    const next = forest();
    next.providers[0].sidebar!.all = 3 + reload;
    await act(async () => pending.at(-1)!.resolve(next));
    expect(head.getAttribute("aria-label")).toBe(`人物参考（${3 + reload} 张）`);
    expect(section("A").contains(chevron) && section("A").contains(folder)).toBe(true);
  }
  expect(props.onError).not.toHaveBeenCalled();
});

it("登记的图库或其可用性变了，旧目录在新结果到达前就隐藏（#121 只放宽内容变化）", async () => {
  const view = await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />));
  const offline = registrations.map((r) => r.library.id === "B" ? { ...r, unavailable: "移动盘没插" } : r);
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "all" })} status={{ revision: "r2", libraries: offline }} />);
  expect(within(section("A")).getByRole("button", { name: "人物参考（… 张）" })).toHaveProperty("disabled", true);
});
