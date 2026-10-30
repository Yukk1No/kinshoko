import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { CommandError } from "../bindings/CommandError";
import { i18n } from "../i18n/instance";
import zh from "../i18n/locales/zh-CN/errors";
import { appInfo, isCursorExpired, isUnknownImage } from "../ipc";
import { CommandFailure, describeCommandError, errorCode, errorText } from "./commandError";

afterEach(async () => { clearMocks(); await i18n.changeLanguage("zh-CN"); });

it("每个错误代码都有中文文案（按结构拼的几种除外）", () => {
  // 后端新增错误代码而这里没有文案时，类型检查报错。
  const texts: Record<Exclude<CommandError["code"], "message" | "captureSourceUnavailable">, string> = zh;
  expect(Object.values(texts).length).toBeGreaterThan(0);
});

it("中文文案与 1.0 的后端原文一致，参数填进去", () => {
  expect(describeCommandError({ code: "cursorExpired" })).toBe("浏览结果已变化，请从头重新浏览");
  expect(describeCommandError({ code: "ambiguousTag", name: "猫" })).toBe("有多个标签叫“猫”，请从候选中选择");
  expect(describeCommandError({ code: "libraryUnavailable", root: "E:\\私人收藏", reason: "拒绝访问" }))
    .toBe("资料库暂时不可用：E:\\私人收藏。请确认移动盘已连接；资料库搬家后请选择新位置重新登记。原因：拒绝访问");
  expect(describeCommandError({ code: "organizeTimedOut", libraries: ["甲库", "乙库"] }))
    .toBe("「甲库」、「乙库」的导入一直没有收尾，这次整理没有执行，请稍后再试");
  expect(describeCommandError({ code: "groupMembersUnavailable", members: [{ member: "a.png", reason: { kind: "originalMissing" } }, { member: null, reason: { kind: "libraryNotRegistered" } }] }))
    .toBe("有成员取不到原图，无法导出参考组包：成员 a.png：原图文件缺失；本设备没有登记这个资料库");
  expect(describeCommandError({ code: "shortcutUsedBy", action: "pinClipboard" })).toBe("这个快捷键已用于“钉剪贴板”");
  expect(describeCommandError({ code: "captureSourceUnavailable", reason: { kind: "imageMissing" } })).toBe("参考图已从资料库中删除");
  expect(describeCommandError({ code: "message", message: "原样显示" })).toBe("原样显示");
  expect(describeCommandError({ code: "system", detail: "Access is denied." })).toBe("Access is denied.");
  expect(describeCommandError({ code: "backupTargetMissing", path: "F:\备份" })).toBe("备份目标不在：F:\备份");
  expect(describeCommandError({ code: "captureCollectIncomplete", number: 2, completed: 1, cause: { code: "unknownImage" } }))
    .toBe("第 2 张截图的收藏未完成：资料库中没有这张参考图。之前完成的 1 张收藏已保留；参考组尚未保存。");
});

it("不认识的错误代码显示通用说明并附原始信息", () => {
  const unknown = { code: "fromTheFuture", detail: "x" } as unknown as CommandError;
  expect(describeCommandError(unknown)).toBe('操作没有完成（错误代码 fromTheFuture）：{"code":"fromTheFuture","detail":"x"}');
});

it("英文界面按代码取英文文案", async () => {
  await i18n.changeLanguage("en");
  expect(describeCommandError({ code: "unknownImage" })).toBe("This reference image isn't in the library");
  expect(describeCommandError({ code: "io", detail: "disk full" })).toBe("Couldn't read or write a file: disk full");
  expect(describeCommandError({ code: "autostartFailed", cause: { code: "system", detail: "Access is denied." } }))
    .toBe("Couldn't change starting with Windows: Access is denied.");
});

it("命令失败时抛出带代码的错误，显示为说明文字", async () => {
  mockIPC(() => Promise.reject({ code: "unknownImage" }));
  const failure = await appInfo().then(() => null, (e: unknown) => e);
  expect(failure).toBeInstanceOf(CommandFailure);
  expect(errorCode(failure)).toBe("unknownImage");
  expect(isUnknownImage(failure)).toBe(true);
  expect(isCursorExpired(failure)).toBe(false);
  expect(String(failure)).toBe("资料库中没有这张参考图");
  expect(errorText(failure)).toBe("资料库中没有这张参考图");
});

it("不是命令错误的失败原样交回", async () => {
  mockIPC(() => Promise.reject("插件不在"));
  await expect(appInfo()).rejects.toBe("插件不在");
  expect(errorText({ code: "cursorExpired" })).toBe("浏览结果已变化，请从头重新浏览");
  expect(errorCode("浏览结果已变化，请从头重新浏览")).toBeUndefined();
});
