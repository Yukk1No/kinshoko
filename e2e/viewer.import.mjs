// 查看器冒烟测试的建库与导入步骤，原样从 viewer.mjs 移出。
export async function createAndImport({ wd, until, find, click, exec, check, base, parent, source }) {
  await wd(
    "POST",
    `${base}/element/${await until("欢迎页", () => find("//button[@aria-labelledby='welcome-create']"))}/click`,
    {},
  ); // #172：欢迎页先选“新建图库”
  const name = await until("建库引导", () => find("//label[contains(., '图库名称')]/input"));
  await wd("POST", `${base}/element/${name}/clear`, {});
  await wd("POST", `${base}/element/${name}/value`, { text: "原图查看器验证" });
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [parent]);
  await click("选择存放位置…");
  await click("新建图库");
  // #113: no current library in the UI (ADR-0008); the new library shows up as a sidebar group head “名称（N 张）”.
  await until("打开图库", () =>
    find(
      "//nav[@aria-label='查找范围']//*[@data-library-id]//button[contains(@class,'lib-head-name') and starts-with(@aria-label,'原图查看器验证（') and not(@disabled)]",
    ),
  );
  check(true, "在独立数据目录建立测试资料库");
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [source]);
  // 设计系统 v2: 导入 is one button; the folder entry is in its menu; the dialog comes prefilled with the library (#416).
  await click("导入");
  await wd(
    "POST",
    `${base}/element/${await until("文件夹菜单项", () => find("//*[@role='menuitem' and normalize-space()='文件夹']"))}/click`,
    {},
  );
  await until("开始导入可用", () =>
    exec(
      "return [...document.querySelectorAll('.k-import-dialog button')].some(b=>b.textContent.trim()==='开始导入'&&!b.disabled)",
    ),
  );
  await click("开始导入");
  await until("导入完成", () =>
    exec(
      "return [...document.querySelectorAll('.k-toast')].some(t=>t.querySelector('.k-toast-title')?.textContent==='导入完成'&&t.querySelector('.k-toast-stats')?.textContent.includes('新增 41'));",
    ),
  );
  // 导入结束是一条轻提示（#388），没有回执卡可关；收起提示，免得盖住右下角。
  await exec("document.querySelectorAll('.k-toast .k-toast-close').forEach(b=>b.click())");
  await until("提示已收起", () => exec("return !document.querySelector('.k-toast')"));
  check(true, "导入 41 张测试参考图，未下载打标模型");
}
