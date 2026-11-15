import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { chooseOption } from "../test/select";
import { tipText } from "../test/tip";
import { parentFolder } from "../library/library-path";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { account, NOW, status, subscription } from "./subscriptions.fixtures";
import { type FakeBackend, fakeBackend } from "../test/backend";

/** 新建图库选好的位置：显示的是缩短的预览，完整路径在悬停提示里。 */
const chosenParent = async (dialog: HTMLElement) =>
  tipText(
    await waitFor(
      () =>
        dialog.querySelector<HTMLElement>(".create-library-path.is-set .create-library-path-text") ??
        Promise.reject(new Error("还没选好位置")),
    ),
  );

// 订阅榜单（#370）：对话框、单独的图库、R-18 榜与安全模式、订阅设置。

let fake: FakeBackend;
const libraries = [
  { library: { id: "L1", name: "主图库", root: "D:/参考图/主图库" }, unavailable: null },
  { library: { id: "L2", name: "私人", root: "D:/参考图/私人" }, unavailable: null },
];
const ranking = (id: string, period: "day" | "week" | "month", top: number, patch: Partial<Subscription> = {}) =>
  subscription(id, "存下的名字", {
    target: { kind: "pixivRanking", period, top, explicit: false },
    backlog: { kind: "all" },
    ...patch,
  });

function backend(subs: Subscription[] = [], newLibraryParent: string | null = null) {
  mockConvertFileSrc("windows");
  fake = fakeBackend({
    subscriptions: subs,
    save_memory: { importDestination: null, newLibraryParent },
    subscription_recent: [],
    workspace_directories: {
      status: { revision: "t", libraries },
      registrationOrder: [],
      providers: libraries.map((registration) => ({
        registration,
        sidebar: { all: 0, trash: 0, folders: [] },
        unassigned: 0,
        descendants: {},
      })),
    },
    create_library_unopened: { id: "L9", name: "pixiv 榜单", root: "D:/参考图/pixiv 榜单" },
    subscription_add: [],
    subscription_set_options: () => subs[0],
  });
}

const sent = (command: string) => fake.calls(command).map((call) => call.args);

function page(s: SubscriptionStatus, safe = false) {
  return render(
    <SaveDestinationProvider safe={safe}>
      <SubscriptionsPage
        status={s}
        onStatus={vi.fn()}
        safe={safe}
        paneOpen
        onPaneToggle={vi.fn()}
        onOpenImage={vi.fn()}
      />
    </SaveDestinationProvider>,
  );
}

async function openRankingDialog() {
  fireEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
  fireEvent.click(await screen.findByRole("menuitem", { name: "榜单" }));
  return screen.findByRole("dialog", { name: "订阅榜单" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
});
afterEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("订阅榜单", () => {
  it("第一次订榜单：预勾日榜前 50，默认在当前图库旁边新建「pixiv 榜单」，建好后不切换过去", async () => {
    backend([subscription("s1", "Mika")]);
    page(status());
    const dialog = await openRankingDialog();
    expect((within(dialog).getByRole("checkbox", { name: "日榜" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("radio", { name: "新建图库" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("textbox", { name: "图库名称" }) as HTMLInputElement).value).toBe("pixiv 榜单");
    expect(await within(dialog).findByText("D:/参考图\\pixiv 榜单")).toBeTruthy();
    // 点周榜的「前 10」顺带勾上周榜。
    fireEvent.click(
      within(within(dialog).getByRole("group", { name: "周榜同步前几名" })).getByRole("button", { name: "前 10" }),
    );
    expect((within(dialog).getByRole("checkbox", { name: "周榜" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("switch", { name: "漫画" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "订阅 2 个榜单" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("create_library_unopened")).toEqual([{ parent: "D:/参考图", name: "pixiv 榜单" }]);
    expect(sent("create_library")).toEqual([]);
    expect(sent("subscription_add")[0]).toEqual({
      subscriptions: [
        {
          target: { kind: "pixivRanking", period: "day", top: 50, explicit: false },
          name: "日榜 前 50",
          libraryId: "L9",
          includeExplicit: true,
          includeManga: true,
          backlog: { kind: "all" },
        },
        {
          target: { kind: "pixivRanking", period: "week", top: 10, explicit: false },
          name: "周榜 前 10",
          libraryId: "L9",
          includeExplicit: true,
          includeManga: true,
          backlog: { kind: "all" },
        },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("没有榜单订阅时，新图库放在上次新建图库的位置；照预填确认不写进记忆", async () => {
    backend([], "E:/别处");
    page(status());
    const dialog = await openRankingDialog();
    expect(await chosenParent(dialog)).toBe("E:/别处");
    fireEvent.click(within(dialog).getByRole("button", { name: /订阅 1 个榜单/ }));
    await waitFor(() => expect(sent("create_library_unopened")).toEqual([{ parent: "E:/别处", name: "pixiv 榜单" }]));
    expect(sent("remember_new_library_parent")).toEqual([]);
  });

  it("亲手选的新建位置写进记忆", async () => {
    backend();
    page(status());
    const dialog = await openRankingDialog();
    window.__KINSHOKO_TEST_PICKS__ = ["F:/亲手选"];
    fireEvent.click(within(dialog).getByRole("button", { name: /选择|更改/ }));
    expect(await chosenParent(dialog)).toBe("F:/亲手选");
    fireEvent.click(within(dialog).getByRole("button", { name: /订阅 1 个榜单/ }));
    await waitFor(() => expect(sent("remember_new_library_parent")).toEqual([{ parent: "F:/亲手选" }]));
  });

  it("也可以放进已有图库；一个都不勾时按钮不能点", async () => {
    backend();
    page(status());
    const dialog = await openRankingDialog();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "日榜" }));
    expect((within(dialog).getByRole("button", { name: "订阅 1 个榜单" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "月榜" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /放进已有图库/ }));
    await chooseOption(within(dialog).getByRole("combobox", { name: "放进已有图库" }), "私人");
    fireEvent.click(within(dialog).getByRole("button", { name: "订阅 1 个榜单" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("create_library_unopened")).toEqual([]);
    expect((sent("subscription_add")[0] as { subscriptions: { libraryId: string }[] }).subscriptions[0].libraryId).toBe(
      "L2",
    );
  });

  it("已有榜单订阅：已订阅的标出名次，默认放进同一个图库，换了别的图库时提示可能重复收", async () => {
    backend([ranking("r1", "day", 50, { libraryId: "L2" })]);
    page(status());
    const dialog = await openRankingDialog();
    const day = within(dialog).getByRole("checkbox", { name: "日榜" }) as HTMLInputElement;
    expect(day.disabled && day.checked).toBe(true);
    expect(within(dialog).getByText("已订阅，前 50")).toBeTruthy();
    // 预勾第一个还没订的。
    expect((within(dialog).getByRole("checkbox", { name: "周榜" }) as HTMLInputElement).checked).toBe(true);
    const library = within(dialog).getByRole("combobox", { name: "图库" });
    await waitFor(() => expect(library.textContent).toContain("私人"));
    expect(within(dialog).queryByText(/可能各存一份/)).toBeNull();
    await chooseOption(library, "主图库");
    expect(within(dialog).getByText("和其他榜单不在同一个图库，同一作品可能各存一份。")).toBeTruthy();
  });

  it("已有榜单订阅时，图库下拉里也能就地新建图库（#442）", async () => {
    backend([ranking("r1", "day", 50, { libraryId: "L2" })]);
    page(status());
    const dialog = await openRankingDialog();
    const library = within(dialog).getByRole("combobox", { name: "图库" });
    await waitFor(() => expect(library.textContent).toContain("私人"));
    await chooseOption(library, "新建图库…");
    const create = await screen.findByRole("dialog", { name: "新建图库" });
    window.__KINSHOKO_TEST_PICKS__ = ["D:/参考图"];
    fireEvent.click(within(create).getByRole("button", { name: "选择存放位置…" }));
    await within(create).findByText("D:/参考图\\我的参考");
    fireEvent.click(within(create).getByRole("button", { name: "新建图库" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建图库" })).toBeNull());
    await waitFor(() => expect(library.getAttribute("data-value")).toBe("L9"));
    expect((within(dialog).getByRole("checkbox", { name: "周榜" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "订阅 1 个榜单" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect((sent("subscription_add")[0] as { subscriptions: { libraryId: string }[] }).subscriptions[0].libraryId).toBe(
      "L9",
    );
    expect(sent("create_library_unopened")).toEqual([{ parent: "D:/参考图", name: "我的参考" }]);
  });

  it("R-18 榜：登录着、账号开着 R-18 时才有，安全模式开着也照常能订；没有 R-18 月榜", async () => {
    for (const safe of [false, true]) {
      backend();
      page(status(), safe);
      const dialog = await openRankingDialog();
      expect(within(dialog).getByRole("switch", { name: "R-18 作品" })).toBeTruthy();
      expect(within(dialog).getByRole("checkbox", { name: "R-18 日榜" })).toBeTruthy();
      expect(within(dialog).getByRole("checkbox", { name: "R-18 周榜" })).toBeTruthy();
      expect(within(dialog).queryByRole("checkbox", { name: "R-18 月榜" })).toBeNull();
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "R-18 周榜" }));
      fireEvent.click(within(dialog).getByRole("radio", { name: /放进已有图库/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: "订阅 2 个榜单" }));
      await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
      expect(
        (sent("subscription_add")[0] as { subscriptions: { target: unknown; name: string }[] }).subscriptions[1],
      ).toMatchObject({
        target: { kind: "pixivRanking", period: "week", top: 10, explicit: true },
        name: "R-18 周榜 前 10",
      });
      cleanup();
    }

    // 关掉「R-18 作品」：R-18 两行收起，勾过的也不订。
    backend();
    page(status());
    let dialog = await openRankingDialog();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "R-18 日榜" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "R-18 作品" }));
    expect(within(dialog).queryByRole("checkbox", { name: "R-18 日榜" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "订阅 1 个榜单" })).toBeTruthy();
    cleanup();

    for (const s of [
      status({ login: { state: "expired", account } }),
      status({ login: { state: "loggedIn", account: { ...account, explicitAllowed: false } } }),
    ]) {
      backend();
      page(s);
      dialog = await openRankingDialog();
      expect(dialog.textContent).not.toMatch(/R-18/);
      cleanup();
    }
  });

  it("名单按语言显示榜单名；订阅设置重命名次与漫画，名字跟着变", async () => {
    backend([ranking("r1", "day", 50)]);
    page(status());
    expect(await screen.findByRole("button", { name: "日榜 前 50" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "更多" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "订阅设置…" }));
    const settings = await screen.findByRole("dialog", { name: "订阅设置" });
    expect(within(settings).getByText("日榜 前 50")).toBeTruthy();
    expect(within(settings).queryByText(/图库/)).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "前 100" }));
    fireEvent.click(within(settings).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(sent("subscription_set_options")).toEqual([
        { id: "r1", includeExplicit: true, includeManga: false, top: 100 },
      ]),
    );
  });

  it("R-18 榜在安全模式下照常列在名单上（藏的只是 R-18 的图）", async () => {
    backend([
      subscription("r2", "存下的名字", { target: { kind: "pixivRanking", period: "day", top: 10, explicit: true } }),
    ]);
    page(status(), true);
    expect(await screen.findByRole("button", { name: "R-18 日榜 前 10" })).toBeTruthy();
  });

  it("新建图库的默认位置：当前图库的上级文件夹", () => {
    expect(parentFolder("D:/参考图/主图库")).toBe("D:/参考图");
    expect(parentFolder("D:\\参考图\\主图库\\")).toBe("D:\\参考图");
    expect(parentFolder("D:\\主图库")).toBe("D:\\");
    expect(parentFolder("主图库")).toBeNull();
  });
});
