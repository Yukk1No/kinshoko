import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { applyInterfaceLanguage, followInterfaceLanguage, i18n } from ".";
import { UpdateNotice, UpdateSection } from "../Update";
import { ToastProvider } from "../ui/Toast";
import { TagGroupBar } from "../search/TagGroupBar";

afterEach(async () => {
  cleanup();
  clearMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

/** 模拟核心：界面语言从 `lang` 开始；标签分组按请求的语言给名称。 */
function backend(lang: string) {
  const asked: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "interface_language") return lang;
    if (cmd === "update_status") return { state: "upToDate" };
    if (cmd === "plugin:library|tag_groups") {
      const requested = (args as { lang: string }).lang;
      asked.push(requested);
      return [{ id: "g", name: requested === "en" ? "Eyes" : "眼睛", namespace: null, tags: [] }];
    }
    return null;
  }, { shouldMockEvents: true });
  return asked;
}

const page = () => render(<>
  <UpdateSection version="Kinshoko 1.1.0" />
  <TagGroupBar libraryId="lib" safe={false} generation={0} input={{ conditions: [], exact: false }} onChange={() => {}} onError={() => {}} />
</>);

describe("界面语言", () => {
  it("没有指定时是简体中文，与 1.0 一致", async () => {
    const asked = backend("zh-CN");
    page();
    expect(await screen.findByText("检查更新", { selector: ".k-label" })).toBeTruthy();
    expect(await screen.findByText("眼睛")).toBeTruthy();
    expect(asked).toEqual(["zh-CN"]);
  });

  it("核心是英文时，页面启动后整条路径都换成英文：文案与核心按语言给的标签名称", async () => {
    const asked = backend("en");
    const stop = followInterfaceLanguage();
    page();
    expect(await screen.findByText("Check for updates", { selector: ".k-label" })).toBeTruthy();
    expect(await screen.findByText("Eyes")).toBeTruthy();
    expect(asked).toContain("en");
    expect(document.documentElement.lang).toBe("en");
    stop();
  });

  it("切换后立即更新，不需重启", async () => {
    const asked = backend("zh-CN");
    const stop = followInterfaceLanguage();
    page();
    expect(await screen.findByText("眼睛")).toBeTruthy();

    await act(async () => { await emit("interface-language", "en"); });
    expect(await screen.findByText("Eyes")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(asked.at(-1)).toBe("en");

    await act(async () => { await emit("interface-language", "zh-CN"); });
    expect(await screen.findByText("眼睛")).toBeTruthy();
    expect(screen.getByText("已是最新")).toBeTruthy();
    stop();
  });

  it("已经显示的更新通知随界面语言换文字", async () => {
    mockIPC((cmd) => {
      if (cmd === "interface_language") return "zh-CN";
      if (cmd === "update_status") return { state: "available", version: "1.2.0", notes: null };
      return null;
    }, { shouldMockEvents: true });
    const stop = followInterfaceLanguage();
    render(<ToastProvider><UpdateNotice /></ToastProvider>);
    expect(await screen.findByText("Kinshoko 1.2.0 可以更新")).toBeTruthy();

    await act(async () => { await emit("interface-language", "en"); });
    expect(await screen.findByText("Kinshoko 1.2.0 is available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeTruthy();
    stop();
  });

  it("没有翻译的语言不切换", async () => {
    backend("zh-CN");
    page();
    await screen.findByText("已是最新");
    act(() => applyInterfaceLanguage("ja"));
    expect(i18n.language).toBe("zh-CN");
    expect(screen.getByText("已是最新")).toBeTruthy();
  });

  it("支持插值与英文复数", async () => {
    i18n.addResourceBundle("en", "probe", { images_one: "{{count}} image", images_other: "{{count}} images" });
    i18n.addResourceBundle("zh-CN", "probe", { images_other: "{{count}} 张" });
    const t = i18n.t as unknown as (key: string, options: object) => string;
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(t("probe:images", { count: 1 })).toBe("1 image");
    expect(t("probe:images", { count: 3 })).toBe("3 images");
    expect(i18n.t("update:install.title", { version: "1.2.0" })).toBe("Update to 1.2.0");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(t("probe:images", { count: 1 })).toBe("1 张");
    await waitFor(() => expect(i18n.t("update:install.title", { version: "1.2.0" })).toBe("可以更新到 1.2.0"));
  });
});
