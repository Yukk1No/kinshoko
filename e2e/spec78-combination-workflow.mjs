// The first continuous T20 session. Importing this file does not start an app.
// Setup uses real public commands. Registration, migration, searching, source curation,
// import destinations, package transfer and receipt consent use rendered product controls.
import { until } from "./spec78-combination-driver.mjs";
import { literal, blank, allScope, dialog, importDialog, libraryChoice, folderChoice, libraryTrigger, libraryMenu } from "./spec78-combination-workflow.xpath.mjs";
import { migrationPhases } from "./spec78-combination-workflow.migration.mjs";
import { sourcesPhases } from "./spec78-combination-workflow.sources.mjs";
import { finishPhases } from "./spec78-combination-workflow.finish.mjs";

export { literal, blank, allScope, named, dialog, importDialog, libraryChoice, folderChoice, eagleDialog } from "./spec78-combination-workflow.xpath.mjs";
export class CombinationWorkflow {
  constructor(driver, fixture) {
    this.d = driver; this.fixture = fixture; this.a = fixture.a.info; this.b = fixture.b.info;
    this.receipts = []; this.state = { phase: "not-started", observations: [] };
  }
  phase(name) { this.state.phase = name; this.d.record("workflow-phase", { name }); this.save(); }
  save() { this.d.save("workflow-state.json", { ...this.state, receipts: this.receipts }); }
  async readyClick(xpath) { await this.d.enabled(xpath); await this.d.click(xpath); }
  // Settings is a dialog with vertical tabs (通用 … 诊断); `tab` selects one by its accessible name.
  async settings(tab = null) {
    if (!await this.d.exec("return !!document.querySelector('section[aria-label=设置]');")) await this.readyClick("//nav[@aria-label='主导航']//button[@aria-label='设置']");
    await this.d.enabled("//button[@aria-label='关闭设置']");
    if (tab !== null) {
      const xpath = `//*[@role='tablist' and @aria-label='设置分页']//*[@role='tab' and normalize-space()=${literal(tab)}]`;
      if (!await this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-selected')==='true';", [xpath])) await this.readyClick(xpath);
      await until("actual settings tab selected: " + tab, () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-selected')==='true';", [xpath]));
    }
  }
  // 设置 › 标签 has a segmented switch: 显示名 / 分组 / 相近 / 对应.
  async tagView(name) {
    const xpath = `//*[@aria-label='标签设置']//button[normalize-space()=${literal(name)}]`;
    if (!await this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-pressed')==='true';", [xpath])) await this.readyClick(xpath);
    await until("actual tag settings view: " + name, () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-pressed')==='true';", [xpath]));
  }
  async closeSettings() {
    if (await this.d.exec("return !!document.querySelector('section[aria-label=设置]');")) await this.readyClick("//button[@aria-label='关闭设置']");
    await until("settings dialog actually closed", () => this.d.exec("return !document.querySelector('section[aria-label=设置]');"));
  }
  // The 图库 ＋ menu (打开图库… · 新建图库… · 管理图库).
  async openLibraryMenu() {
    if (await this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-expanded')!=='true';", [libraryTrigger])) await this.readyClick(libraryTrigger);
    await this.d.enabled(libraryMenu);
  }
  async closeMenu() {
    if (!await this.d.exec("return !!document.querySelector('[role=menu]');")) return;
    await this.d.key("");
    await until("actual menu closed", () => this.d.exec("return !document.querySelector('[role=menu]');"));
  }
  async root(id) {
    const root = (await this.d.invoke("registered_libraries")).find(entry => entry.library.id === id)?.library.root;
    if (!root) throw Error("No registered provider " + id);
    return root;
  }
  // Visible check: the provider is an enabled group head in the sidebar (“名称（N 张）”), its root as the
  // section's provider. The UI has no current library (ADR-0008); the backend's writable handle is checked separately.
  async shownCurrent(id) {
    const root = await this.root(id);
    const head = `//nav[@aria-label='查找范围']//*[@data-library-id=${literal(id)}]//button[contains(@class,'lib-head-name') and not(@disabled)]`;
    await until("sidebar shows the connected provider " + id, () => this.d.find(head));
    return { root, head };
  }
  // The writable library is switched on demand by the backend (ADR-0008). Tests that need a particular one
  // switch it through the command; the sidebar must still list it as connected.
  async current(id) {
    await this.d.invoke("switch_library", { libraryId: id });
    await until("current provider actually switched", async () => (await this.d.invoke("current_library"))?.id === id);
    await this.closeMenu(); await this.shownCurrent(id);
  }
  // A modal dialog makes the sidebar unreachable (see strictAdultAndConsent); the command switch does not need it.
  async currentBehindModal(id) {
    const root = await this.root(id);
    await this.d.invoke("switch_library", { libraryId: id });
    await until("current provider actually switched behind the modal", async () => (await this.d.invoke("current_library"))?.id === id);
    this.d.record("current-behind-modal", { id, root, method: "switch_library command; the UI no longer has a current-library control (ADR-0008)" });
  }
  // Opening an existing library (old: 登记已有资料库…): the welcome page's 打开图库 card, or 打开图库… in the library menu.
  async openLibrary(path) {
    await this.d.pick(path);
    const inline = "//button[@aria-labelledby='welcome-open']"; // #172 欢迎页的“打开图库”
    const entry = await until("a visible open-library entry", () => this.d.exec("const shown=x=>{const n=document.evaluate(x,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!n&&n.getClientRects().length>0;};return shown(arguments[0])?'inline':shown(arguments[1])?'menu':null;", [inline, libraryTrigger]));
    if (entry === "inline") await this.readyClick(inline);
    else { await this.openLibraryMenu(); await this.readyClick(`${libraryMenu}//*[@role='menuitem' and normalize-space()='打开图库…']`); }
  }
  async scope(libraryId = null, folderId = null) {
    if(!await this.d.exec("return document.querySelector('button[aria-label=图片与文件夹]')?.getAttribute('aria-expanded')==='true';"))await this.readyClick("//button[@aria-label='图片与文件夹']");
    const xpath = libraryId === null ? "//nav[@aria-label='查找范围']//button[normalize-space()='全部图片']"
      : folderId === null ? `//nav[@aria-label='查找范围']//*[@data-library-id=${literal(libraryId)}]/div[contains(@class,'workspace-provider-root')]/button[contains(@class,'sidebar-item')]`
      : `//nav[@aria-label='查找范围']//*[@data-library-id=${literal(libraryId)}]//button[@data-folder-id=${literal(folderId)} and contains(@class,'sidebar-item')]`;
    await this.readyClick(xpath);
    await until("actual selected browse control", () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-current')==='page';", [xpath]));
  }
  async clearSearch() {
    while (await this.d.exec("return document.querySelectorAll('[aria-label=查找条件] button[aria-label=去掉这个条件]').length;")) await this.readyClick("//ul[@aria-label='查找条件']//button[@aria-label='去掉这个条件']");
    await this.d.set("//input[@aria-label='查找参考图']", "");
  }
  async searchTag(name) {
    await this.d.type("//input[@aria-label='查找参考图']", name);
    const candidate = `//ul[@id='search-candidates']//li[@role='option'][span[contains(@class,'search-candidate-name') and normalize-space()=${literal(name)}]]`;
    await this.readyClick(candidate);
  }
  async allPages(scope = allScope, conditions = blank, safeMode = true) {
    // Like the product wall: a revision change during paging expires the snapshot; restart from page one.
    for (let attempt = 0; ; attempt++) {
      let cursor = null; const cards = [], statuses = [];
      try {
        do {
          const page = await this.d.invoke("workspace_browse", { query: { scope, conditions, cursor, limit: 100, thumbnailPx: 128 }, safeMode });
          cards.push(...page.cards); statuses.push({ revision: page.status.revision, total: page.total }); cursor = page.nextCursor;
        } while (cursor !== null);
        return { cards, total: statuses.at(-1).total, statuses, attempts: attempt + 1 };
      } catch (error) {
        if (attempt >= 5 || !String(error).includes("浏览结果已变化")) throw error;
        await new Promise(done => setTimeout(done, 300));
      }
    }
  }
  // Wait until the public workspace revision has been unchanged for quietMs (a burst of import events has ended).
  settled(quietMs = 1500) {
    let last = null, since = Date.now();
    return until("workspace revision settles", async () => {
      const now = (await this.d.invoke("workspace_status", { safeMode: true })).revision;
      if (now !== last) { last = now; since = Date.now(); return null; }
      return Date.now() - since >= quietMs ? now : null;
    });
  }
  local(libraryId, folderId = null, safeMode = true) {
    return this.allPages({ kind: "library", libraryId, scope: folderId === null ? { kind: "all" } : { kind: "folder", id: folderId } }, blank, safeMode);
  }
  async task(id) { return (await this.d.invoke("import_tasks")).find(task => task.taskId === id); }
  finish(id, timeout = 90000) { return until("real completed import receipt " + id, async () => { const task = await this.task(id); return task?.report && !task.finishing ? task : null; }, timeout); }
  // The recycle bin row in the sidebar foot follows the selected library (“回收站（名称，N 张）”, #113): select the
  // library first, then its row opens that library's bin.
  async trash(libraryId) {
    await this.scope(libraryId);
    const name = (await this.d.invoke("registered_libraries")).find(entry => entry.library.id === libraryId)?.library.name;
    const xpath = `//nav[@aria-label='查找范围']//div[contains(@class,'side-foot')]//button[starts-with(@aria-label,${literal("回收站（" + name + "，")})]`;
    await this.readyClick(xpath);
    await until("actual recycle-bin scope of " + libraryId, () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-current')==='page';", [xpath]));
    return xpath;
  }
  // Import (设计系统 v2): pick first, choose 图片 in the 导入 menu, then a dialog chooses the library and folder; progress/result are bottom-right cards.
  async chooseDestination(libraryId, folderId = null, prefix = importDialog) {
    await this.d.select(libraryChoice(prefix), libraryId);
    await this.d.select(folderChoice(prefix), folderId ?? "");
  }
  async beginImport(paths, libraryId, folderId = null) {
    const before = new Set((await this.d.invoke("import_tasks")).map(task => task.taskId));
    await this.d.pick(paths); await this.readyClick("//button[@aria-label='导入']");
    await this.readyClick("//*[@role='menu']//*[@role='menuitem' and starts-with(normalize-space(),'图片')]");
    await this.d.enabled(libraryChoice(importDialog));
    await this.chooseDestination(libraryId, folderId);
    await this.readyClick(`${importDialog}//button[normalize-space()='开始导入']`);
    const started = await until("new actual import task", async () => (await this.d.invoke("import_tasks")).find(task => !before.has(task.taskId)));
    this.d.assert(started.destination.libraryId === libraryId && started.destination.folderId === folderId, "submitted import owns the explicitly selected provider and folder", started);
    return started.taskId;
  }
  async import(paths, libraryId, folderId = null) {
    const id = await this.beginImport(paths, libraryId, folderId), task = await this.finish(id);
    this.receipts.push(task); this.save();
    this.d.assert(!task.report.cancelled && task.warnings.length === 0, "actual import completes and publishes provider definitions", { taskId: id, report: task.report, warnings: task.warnings });
    return task;
  }
  async catalog() { return (await this.d.invoke("inspect_tag_catalog")).catalog; }
  mapped(catalog, libraryId, localTagId) { return catalog.mappings.find(mapping => mapping.libraryId === libraryId && mapping.localTagId === localTagId)?.catalogId; }
  prefer(catalogId, name) { return this.d.invoke("edit_tag_name", { catalogId, edit: { kind: "prefer", name: { lang: "zh-CN", name } } }); }
  inspect(target, safeMode = true) { return this.d.invoke("workspace_source_inspection", { target, safeMode, lang: "zh-CN" }); }
}
// The phase methods live in sibling modules to keep each file small.
Object.assign(CombinationWorkflow.prototype, migrationPhases, sourcesPhases, finishPhases);
