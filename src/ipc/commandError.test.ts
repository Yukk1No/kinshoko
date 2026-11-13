import { afterEach, expect, it } from "vitest";
import type { CommandError } from "../bindings/CommandError";
import { i18n } from "../i18n/instance";
import zh from "../i18n/locales/zh-CN/errors";
import { appInfo, isCursorExpired, isUnknownImage } from "../ipc";
import {
  CommandFailure,
  describeCommandError,
  describeCommandErrors,
  errorCode,
  errorText,
  storedReasonText,
} from "./commandError";
import { fakeBackend } from "../test/backend";

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

it("每个错误代码都有中文文案（按结构拼的几种除外）", () => {
  // 后端新增错误代码而这里没有文案时，类型检查报错。
  const texts: Record<
    Exclude<CommandError["code"], "message" | "captureSourceUnavailable" | "backupProblems">,
    string
  > = zh;
  expect(Object.values(texts).length).toBeGreaterThan(0);
});

it("中文文案与 1.0 的后端原文一致，参数填进去", () => {
  expect(describeCommandError({ code: "cursorExpired" })).toBe("浏览结果已变化，请从头重新浏览");
  expect(describeCommandError({ code: "ambiguousTag", name: "猫" })).toBe("有多个标签叫“猫”，请从候选中选择");
  expect(
    describeCommandError({
      code: "libraryUnavailable",
      root: "E:\\私人收藏",
      reason: { code: "system", detail: "拒绝访问" },
    }),
  ).toBe("图库暂时无法连接：E:\\私人收藏。请确认移动盘已接上；图库换了位置的话，请重新打开新位置。原因：拒绝访问");
  expect(describeCommandError({ code: "organizeTimedOut", libraries: ["甲库", "乙库"] })).toBe(
    "「甲库」、「乙库」的导入迟迟没有完成，这次整理没有执行，请稍后再试",
  );
  expect(
    describeCommandError({
      code: "groupMembersUnavailable",
      members: [
        { member: "a.png", reason: { kind: "originalMissing" } },
        { member: null, reason: { kind: "libraryNotRegistered" } },
      ],
    }),
  ).toBe("有成员无法读取原图，无法导出参考组包：成员 a.png：原图文件缺失；本设备没有打开这个图库");
  expect(describeCommandError({ code: "shortcutUsedBy", action: "pinClipboard" })).toBe("这个快捷键已用于“钉住剪贴板”");
  expect(describeCommandError({ code: "captureSourceUnavailable", reason: { kind: "imageMissing" } })).toBe(
    "参考图已从图库中删除",
  );
  expect(describeCommandError({ code: "message", message: "原样显示" })).toBe("原样显示");
  expect(describeCommandError({ code: "system", detail: "Access is denied." })).toBe("Access is denied.");
  expect(describeCommandError({ code: "backupTargetMissing", path: "F:\备份" })).toBe("备份位置不在：F:\备份");
  expect(
    describeCommandError({
      code: "captureCollectIncomplete",
      number: 2,
      completed: 1,
      cause: { code: "unknownImage" },
    }),
  ).toBe("第 2 张截图的收藏未完成：图库中没有这张参考图。之前完成的 1 张收藏已保留；参考组尚未保存。");
});

it("备份与往返检查的原因按结构拼出；旧版本写下的原因照原样显示", () => {
  expect(
    describeCommandError({
      code: "backupProblems",
      problems: [
        { code: "backupGroupNewLibrary", name: "人体" },
        { code: "backupOriginalProblem", name: "主库", file: "a.png", cause: { code: "backupOriginalChanged" } },
      ],
    }),
  ).toBe(
    "参考组“人体”引用了新的图库，请重新估算备份范围后重试；图库“主库”的原图 a.png：原图内容与图库记录不符（可能被外部改动），这次备份不完整",
  );
  expect(
    describeCommandError({ code: "checkTableMismatch", table: "tag", snapshot: 3, restored: 2, sameContent: true }),
  ).toBe("表 tag：快照 3 行，恢复后 2 行，内容一致");
  expect(
    describeCommandError({ code: "checkTableMismatch", table: "tag", snapshot: 3, restored: 2, sameContent: false }),
  ).toBe("表 tag：快照 3 行，恢复后 2 行，内容不一致");
  expect(storedReasonText("备份位置不在：E盘")).toBe("备份位置不在：E盘");
  expect(storedReasonText({ code: "backupLibraryNotRegistered" })).toBe("本设备没有打开这个图库");
});

it("不认识的错误代码显示通用说明并附原始信息", () => {
  const unknown = { code: "fromTheFuture", detail: "x" } as unknown as CommandError;
  expect(describeCommandError(unknown)).toBe(
    '操作没有完成（错误代码 fromTheFuture）：{"code":"fromTheFuture","detail":"x"}',
  );
});

it("英文界面按代码取英文文案", async () => {
  await i18n.changeLanguage("en");
  expect(describeCommandError({ code: "unknownImage" })).toBe("This reference image isn't in the library");
  expect(describeCommandError({ code: "io", detail: "disk full" })).toBe("Couldn't read or write a file: disk full");
  expect(
    describeCommandError({ code: "autostartFailed", cause: { code: "system", detail: "Access is denied." } }),
  ).toBe("Couldn't change starting with Windows: Access is denied.");
  expect(describeCommandErrors([{ code: "taggingNoGpu" }, { code: "taggingRamShort", need: "5.4 GB" }])).toBe(
    "There's no dedicated graphics card; There isn't enough free memory (needs about 5.4 GB)",
  );
  expect(describeCommandError({ code: "checkOriginalCount", snapshot: 3, restored: 2 })).toBe(
    "The number of originals doesn't match: 3 in the snapshot, 2 after restoring",
  );
});

it("命令失败时抛出带代码的错误，显示为说明文字", async () => {
  fakeBackend({ app_info: () => Promise.reject({ code: "unknownImage" }) });
  const failure = await appInfo().then(
    () => null,
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(CommandFailure);
  expect(errorCode(failure)).toBe("unknownImage");
  expect(isUnknownImage(failure)).toBe(true);
  expect(isCursorExpired(failure)).toBe(false);
  expect(String(failure)).toBe("图库中没有这张参考图");
  expect(errorText(failure)).toBe("图库中没有这张参考图");
});

it("不是命令错误的失败原样交回", async () => {
  fakeBackend({ app_info: () => Promise.reject("插件不在") });
  await expect(appInfo()).rejects.toBe("插件不在");
  expect(errorText({ code: "cursorExpired" })).toBe("浏览结果已变化，请从头重新浏览");
  expect(errorCode("浏览结果已变化，请从头重新浏览")).toBeUndefined();
});

it("插件失败与前端异常只显示通用说明，原文写进运行日志", async () => {
  const logged: string[] = [];
  fakeBackend({
    log_frontend: (args) => {
      logged.push((args as { message: string }).message);
      return null;
    },
  });
  expect(errorText(new TypeError("Cannot read properties of undefined"))).toBe("出了点问题，详情在运行日志里");
  expect(errorText("dialog plugin: permission denied")).toBe("出了点问题，详情在运行日志里");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(logged).toEqual([
    "Unexpected error: TypeError: Cannot read properties of undefined",
    "Unexpected error: dialog plugin: permission denied",
  ]);
  await i18n.changeLanguage("en");
  expect(errorText(new Error("x"))).toBe("Something went wrong. Details are in the run log.");
});
