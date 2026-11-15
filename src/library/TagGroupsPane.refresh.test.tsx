import { beforeEach, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "../App";
import { appStartup } from "../App.fixtures";
import type { Candidate } from "../bindings/Candidate";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { fakeBackend, shellSettings } from "../test/backend";

const library = { id: "L1", name: "工作参考", root: "D:\\synthetic-t20\\工作参考" };
const tag = { id: "shared-blue", namespace: "general" as const, name: "蓝发", untranslated: false, hasExternal: true };
let groups: CatalogGroupView[];
let status: WorkspaceStatus;
let readGroups: () => CatalogGroupView[] | Promise<CatalogGroupView[]>;
let readCandidates: () => Candidate[] | Promise<Candidate[]>;

beforeEach(() => {
  groups = [];
  readGroups = () => structuredClone(groups);
  readCandidates = () => [{ tag, via: null, count: 1 }];
  status = { revision: "workspace-r1", libraries: [{ library, unavailable: null }] };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  fakeBackend({
    ...appStartup,
    app_info: { productName: "Kinshoko", version: "probe" },
    current_library: library,
    registered_libraries: () => status.libraries,
    workspace_status: () => structuredClone(status),
    workspace_directories: () => ({
      status: structuredClone(status),
      providers: [
        {
          registration: status.libraries[0],
          unassigned: 1,
          descendants: {},
          sidebar: { all: 1, trash: 0, folders: [] },
        },
      ],
    }),
    workspace_browse: () => ({ status: structuredClone(status), cards: [], nextCursor: null, total: 0 }),
    recovery: { interrupted: [], orphans: [], discardedStaging: 0 },
    shared_tag_groups: () => readGroups(),
    workspace_tag_groups: [],
    workspace_resolve: { conditions: [] },
    workspace_candidates: (args) => (String(args.text).includes("蓝") ? readCandidates() : []),
    create_shared_tag_group: (args) => {
      groups.push({ id: "G1", name: String(args.name), namespace: null, tags: [], sources: [] });
      status = { ...status, revision: "workspace-r2" };
      return "G1";
    },
    edit_shared_tag_group: (args) => {
      const edit = args.edit as CatalogGroupEdit;
      if (edit.kind !== "addMembers") throw new Error("Unexpected edit in picker regression");
      groups[0] = { ...groups[0], tags: [{ tag, count: 1 }] };
      return null;
    },
    tagging_status: { state: "starting" },
    shell_settings: shellSettings(),
  });
});

async function openPicker(beforePicker?: () => Promise<void>) {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑分组" }));
  expect(await screen.findByRole("dialog", { name: "编辑分组" })).toBeTruthy();
  const region = await screen.findByRole("region", { name: "标签分组" });
  // The create button stays disabled until the first group refresh settles.
  fireEvent.click(
    await waitFor(() => {
      const button = within(region).getByRole<HTMLButtonElement>("button", { name: "新建标签分组" });
      expect(button.disabled).toBe(false);
      return button;
    }),
  );
  const name = within(region).getByRole("textbox", { name: "新标签分组名称" });
  fireEvent.change(name, { target: { value: "发色" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await within(region).findByRole("group", { name: "发色" });
  if (beforePicker) await beforePicker();
  const group = await within(region).findByRole("group", { name: "发色" });
  fireEvent.click(within(group).getByRole("button", { name: "给“发色”添加标签" }));
  const input = within(group).getByRole<HTMLInputElement>("combobox", { name: "挑一个标签" });
  fireEvent.change(input, { target: { value: "蓝" } });
  await screen.findByRole("option", { name: /蓝发/ });
  return { region, input };
}
async function addMember(region: HTMLElement) {
  const input = await within(region).findByRole<HTMLInputElement>("combobox", { name: "挑一个标签" });
  expect(input.value).toBe("蓝");
  fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
  expect(await within(region).findByRole("button", { name: "蓝发（1 张）" })).toBeTruthy();
}

it("keeps the draft when the group creation workspace notification arrives after typing", async () => {
  const { region } = await openPicker();
  await act(async () => {
    await emit("workspace-changed", structuredClone(status));
  });
  await addMember(region);
});

it("keeps typing through repeated vocabulary notifications with the same library revision", async () => {
  const event = { kind: "vocabularyChanged", libraryId: "L1", revision: 1 };
  const { region } = await openPicker(async () => {
    await act(async () => {
      await emit("library-event", event);
    });
  });
  await act(async () => {
    await emit("library-event", event);
  });
  await addMember(region);
});

it("keeps typing when the monitor repeats an observed workspace revision", async () => {
  const { region } = await openPicker(async () => {
    await act(async () => {
      await emit("workspace-changed", structuredClone(status));
    });
  });
  await act(async () => {
    await emit("workspace-changed", structuredClone(status));
  });
  await addMember(region);
});

it("closes the draft and old candidates when the safety mode really changes", async () => {
  const { region } = await openPicker();
  await act(async () => {
    await emit("safe-mode-setting", false);
  });
  expect(within(region).queryByRole("combobox", { name: "挑一个标签" })).toBeNull();
  expect(screen.queryByRole("option", { name: /蓝发/ })).toBeNull();
});

it("keeps the focused input while withholding stale labels and ignoring a late old candidate", async () => {
  const { region, input } = await openPicker();
  let finishOld!: (value: Candidate[]) => void;
  readCandidates = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  fireEvent.change(input, { target: { value: "蓝发" } });
  let finishNew!: (value: Candidate[]) => void;
  let finishGroups!: (value: CatalogGroupView[]) => void;
  readCandidates = () =>
    new Promise((resolve) => {
      finishNew = resolve;
    });
  readGroups = () =>
    new Promise((resolve) => {
      finishGroups = resolve;
    });
  await act(async () => {
    await emit("library-event", { kind: "vocabularyChanged", libraryId: "L1", revision: 1 });
  });
  expect(within(region).getByRole("combobox", { name: "挑一个标签" })).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("蓝发");
  expect(within(region).queryByRole("group", { name: "发色" })).toBeNull();
  expect(screen.queryByRole("option")).toBeNull();
  await act(async () => {
    finishOld([{ tag: { ...tag, name: "失效的旧标签" }, via: null, count: 99 }]);
  });
  expect(within(region).queryByText("失效的旧标签")).toBeNull();
  await act(async () => {
    finishNew([{ tag, via: null, count: 1 }]);
    finishGroups(structuredClone(groups));
  });
  expect(await screen.findByRole("option", { name: /蓝发/ })).toBeTruthy();
  expect(within(region).getByRole("combobox", { name: "挑一个标签" })).toBe(input);
});

it("closes a draft whose group was deleted during refresh", async () => {
  const { region } = await openPicker();
  groups = [];
  await act(async () => {
    await emit("workspace-changed", { ...status, revision: "workspace-r3" });
  });
  expect(within(region).queryByRole("combobox", { name: "挑一个标签" })).toBeNull();
});
