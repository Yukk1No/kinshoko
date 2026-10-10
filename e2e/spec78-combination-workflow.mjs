// The first continuous T20 session. Importing this file does not start an app.
// Setup uses real public commands. Registration, migration, searching, source curation,
// import destinations, package transfer and receipt consent use rendered product controls.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./spec78-combination-driver.mjs";

export const literal = value => String(value).includes("'") ? "concat(" + String(value).split("'").map(part => "'"+part+"'").join(",\"'\",") + ")" : "'"+value+"'";
export const blank = { conditions: [] };
export const allScope = { kind: "all" };
// #98 redesign: controls are found by role and accessible name. Dock buttons are named "名称，快捷键".
export const named = value => `(@aria-label=${literal(value)} or starts-with(@aria-label,${literal(value+"，")}) or normalize-space()=${literal(value)})`;
// Base UI dialogs are named by their title (aria-labelledby); older dialogs by aria-label.
export const dialog = name => `//*[@role='dialog' and (@aria-label=${literal(name)} or @aria-labelledby=//*[normalize-space()=${literal(name)}]/@id)]`;
export const importDialog = dialog("导入图片"), eagleDialog = dialog("从 Eagle 导入");
const libraryTrigger = "//button[starts-with(@aria-label,'当前图库：')]";
const libraryMenu = "//*[@role='menu' and @aria-label='图库']";
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
  // The current library is a sidebar title menu (single choice). Same-name providers are told apart by their root (title).
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
  // Visible check: the library menu's checked radio is exactly this provider's root.
  async shownCurrent(id) {
    const root = await this.root(id);
    await this.openLibraryMenu();
    const shown = await until("library menu marks the actual current provider", () => this.d.exec("const items=[...document.querySelectorAll('[role=menu][aria-label=图库] [role=menuitemradio]')];const on=items.filter(item=>item.getAttribute('aria-checked')==='true');return on.length===1&&on[0].getAttribute('title')===arguments[0]?{root:arguments[0],items:items.length}:null;", [root]));
    await this.closeMenu();
    return shown;
  }
  async current(id) {
    const root = await this.root(id);
    await this.openLibraryMenu();
    await this.readyClick(`${libraryMenu}//*[@role='menuitemradio' and @title=${literal(root)}]`);
    await until("current provider actually switched", async () => (await this.d.invoke("current_library"))?.id === id);
    await this.closeMenu(); await this.shownCurrent(id);
  }
  // Only for a state where a modal dialog makes the library menu unreachable (see strictAdultAndConsent).
  async currentBehindModal(id) {
    const root = await this.root(id);
    const press = "const fire=(el)=>{for(const [type,C] of [['pointerdown',PointerEvent],['mousedown',MouseEvent],['pointerup',PointerEvent],['mouseup',MouseEvent],['click',MouseEvent]])el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,composed:true,button:0,buttons:type.endsWith('down')?1:0,pointerType:'mouse',pointerId:1,isPrimary:true,view:window}));};";
    await this.d.exec(press + "const t=document.querySelector('button[aria-label^=\"当前图库：\"]');if(!t)throw Error('library menu trigger missing');fire(t);return true;");
    await until("library menu opened behind the modal", () => this.d.exec("return !!document.querySelector('[role=menu][aria-label=图库]');"));
    await this.d.exec(press + "const item=[...document.querySelectorAll('[role=menu][aria-label=图库] [role=menuitemradio]')].find(n=>n.getAttribute('title')===arguments[0]);if(!item)throw Error('provider item missing');fire(item);return true;", [root]);
    await until("current provider actually switched behind the modal", async () => (await this.d.invoke("current_library"))?.id === id);
    this.d.record("current-behind-modal", { id, root, method: "synthetic pointer/mouse events on the library menu, as the old JS select change" });
  }
  // Opening an existing library (old: 登记已有资料库…): the inline onboarding button, or 打开图库… in the library menu.
  async openLibrary(path) {
    await this.d.pick(path);
    const inline = "//section[@aria-label='图库']//button[normalize-space()='打开图库…']";
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
  // The recycle bin of the active library is pinned to the sidebar foot; other libraries show their own.
  async trash(libraryId) {
    if (await this.d.exec("return document.querySelector('button[aria-label=图片与文件夹]')?.getAttribute('aria-expanded')!=='true';")) await this.readyClick("//button[@aria-label='图片与文件夹']");
    const active = (await this.d.invoke("current_library"))?.id === libraryId;
    const xpath = active ? "//nav[@aria-label='查找范围']//div[contains(@class,'side-foot')]//button[starts-with(@aria-label,'回收站（')]"
      : `//nav[@aria-label='查找范围']//*[@data-library-id=${literal(libraryId)}]//button[starts-with(@aria-label,'回收站（')]`;
    await this.readyClick(xpath);
    await until("actual recycle-bin scope of " + libraryId, () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.getAttribute('aria-current')==='page';", [xpath]));
    return xpath;
  }
  // Import (#98): pick first, then a dialog chooses the library and folder; progress/result are bottom-right cards.
  async chooseDestination(libraryId, folderId = null, prefix = importDialog) {
    await this.d.select(`${prefix}//select[@aria-label='保存到资料库']`, libraryId);
    await this.d.select(`${prefix}//select[@aria-label='保存到文件夹']`, folderId ?? "");
  }
  async beginImport(paths, libraryId, folderId = null) {
    const before = new Set((await this.d.invoke("import_tasks")).map(task => task.taskId));
    await this.d.pick(paths); await this.readyClick("//button[@aria-label='导入图片文件']");
    await this.d.enabled(`${importDialog}//select[@aria-label='保存到资料库']`);
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
  async registerAndMigrate() {
    this.phase("register-and-migrate");
    this.d.assert((await this.d.invoke("registered_libraries")).length === 0, "the combined session starts with its own empty device registry");
    for (const library of [this.a, this.b]) {
      await this.openLibrary(library.root);
      await until("registered and current " + library.id, async () => (await this.d.invoke("current_library"))?.id === library.id);
      await this.shownCurrent(library.id);
    }
    const entries = await this.d.invoke("registered_libraries");
    this.d.assert(entries.length === 2 && entries.every(entry => entry.unavailable === null), "the one session contains exactly the two independently stored providers", entries);
    // 旧资料库名称迁移 is now the 确认旧名称 wizard, one tag at a time, opened from 设置 › 标签 › 显示名.
    await this.settings("标签"); await this.tagView("显示名");
    await this.readyClick("//section[@aria-label='设置']//*[@role='status' and contains(.,'个旧名称待确认')]//button[normalize-space()='逐个确认']");
    const wizard = dialog("确认旧名称");
    await this.d.enabled(`${wizard}//*[@role='radiogroup' and @aria-label='名称归属']`);
    const migration = await this.d.invoke("plan_legacy_names");
    this.d.assert(migration.plan.groups.length > 0, "released-v16 inputs expose real unresolved legacy names", migration);
    const catalogBefore = await this.catalog();
    this.parted = this.mapped(catalogBefore, this.a.id, this.fixture.a.tags.parted_hair);
    const expected=this.fixture.migrationEqualDefault;
    const required=migration.plan.groups.find(group=>group.catalogId===this.parted);
    this.d.assert(expected&&required&&required.defaultName===expected.name&&required.sources.some(source=>source.legacyName===expected.name&&source.libraryId===this.b.id),"the real migration must contain B's old name equal to the installed bundled default",{expected,required});
    let equalDefaultChoice = null;
    for (let index = 0; index < migration.plan.groups.length; index++) {
      const group = migration.plan.groups[index];
      const matching = group.sources.findIndex(source => source.legacyName === group.defaultName);
      const choice = group.catalogId === this.parted && matching >= 0 ? `legacy:${matching}` : "default";
      const count = `${index + 1} / ${migration.plan.groups.length}`;
      await until("wizard shows actual step " + count, () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.textContent.trim()===arguments[1];", [`${wizard}//*[contains(@class,'k-steps-count')]`, count]));
      const radio = `${wizard}//*[@role='radiogroup' and @aria-label='名称归属']//input[@type='radio' and @value=${literal(choice)}]`;
      await this.readyClick(radio);
      await until("actual name choice checked " + count, () => this.d.exec("return document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue?.checked===true;", [radio]));
      if (choice.startsWith("legacy:")) equalDefaultChoice = { catalogId: group.catalogId, value: group.sources[matching].legacyName };
      // After the last choice, 下一个 moves to the review page (all chosen).
      await this.readyClick(`${wizard}//button[normalize-space()='下一个']`);
    }
    await this.d.enabled(`${wizard}//table[@aria-label='迁移后最终显示']`);
    await this.readyClick(`${wizard}//button[normalize-space()='确认名称']`);
    await until("saved explicit migration", () => this.d.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node?.textContent.includes('旧名称已确认。');", [wizard]));
    this.d.assert((await this.d.invoke("plan_legacy_names")).plan.groups.length === 0, "both providers' legacy choices are actually resolved");
    const catalog = await this.catalog();
    for (const external of ["parted_hair", "blue_eyes", "aqua_eyes"]) {
      const a = this.mapped(catalog, this.a.id, this.fixture.a.tags[external]), b = this.mapped(catalog, this.b.id, this.fixture.b.tags[external]);
      this.d.assert(a && a === b && this.fixture.a.tags[external] !== this.fixture.b.tags[external], "different local tag IDs share the same external identity: " + external, { a, b });
    }
    this.blue = this.mapped(catalog, this.a.id, this.fixture.a.tags.blue_eyes);
    this.aqua = this.mapped(catalog, this.a.id, this.fixture.a.tags.aqua_eyes);
    const unrelatedA = this.mapped(catalog, this.a.id, this.fixture.a.tags.provider_a_meaning), unrelatedB = this.mapped(catalog, this.b.id, this.fixture.b.tags.provider_b_meaning);
    const character = this.mapped(catalog, this.a.id, this.fixture.a.tags.sample_character);
    this.d.assert(unrelatedA && unrelatedB && unrelatedA !== unrelatedB && character !== this.parted, "same words and different namespaces do not silently merge meanings", { unrelatedA, unrelatedB, character, parted: this.parted });
    this.d.assert(equalDefaultChoice?.value===expected.name&&catalog.tags.find(tag => tag.id === equalDefaultChoice.catalogId).namePreferences.some(name => name.lang==="zh-CN"&&name.name === equalDefaultChoice.value), "keeping a legacy name equal to its default records an explicit preference", equalDefaultChoice);
    this.state.equalDefaultChoice = equalDefaultChoice;
    await this.d.screenshot("01-real-legacy-migration.png");
    await this.readyClick(`${wizard}//button[normalize-space()='完成']`);
    await until("name wizard closed", () => this.d.exec("return !document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;", [wizard]));
    await this.closeSettings();
  }
  async importAndCurate() {
    this.phase("import-and-independent-curation");
    await this.current(this.a.id);
    this.folderA = await this.d.invoke("create_folder", { libraryId: this.a.id, name: "同名目录", parent: null });
    this.childA = await this.d.invoke("create_folder", { libraryId: this.a.id, name: "子目录", parent: this.folderA });
    await this.current(this.b.id);
    this.folderB = await this.d.invoke("create_folder", { libraryId: this.b.id, name: "同名目录", parent: null });
    await this.current(this.a.id);
    const { visible, sealed, unknown, virtual } = this.fixture.inputs;
    await this.import([visible.path, sealed.path, unknown.path, ...virtual.map(item => item.path)], this.a.id, this.folderA);
    await this.import([visible.path, sealed.path], this.b.id, this.folderB);
    const a = await this.local(this.a.id), b = await this.local(this.b.id);
    const card = a.cards.find(card => card.width === visible.width && card.height === visible.height);
    this.d.assert(card && b.cards.some(other => other.id === card.id), "both providers imported the exact position-and-alpha original", { a: card, b: b.cards.find(other => other.id === card?.id) });
    this.visibleCard = (await this.allPages()).cards.find(item => item.id === card.id);
    this.targetA = { libraryId: this.a.id, imageId: this.visibleCard.sources.find(source => source.libraryId === this.a.id).imageId, contentId: card.id };
    this.targetB = { libraryId: this.b.id, imageId: this.visibleCard.sources.find(source => source.libraryId === this.b.id).imageId, contentId: card.id };
    const sealedCard = (await this.allPages()).cards.find(card => card.width === sealed.width && card.height === sealed.height);
    this.sealedA = { libraryId: this.a.id, imageId: sealedCard.sources.find(source => source.libraryId === this.a.id).imageId, contentId: sealedCard.id };
    this.sealedB = { libraryId: this.b.id, imageId: sealedCard.sources.find(source => source.libraryId === this.b.id).imageId, contentId: sealedCard.id };
    for (const [target, note, external] of [[this.targetA,"甲来源独立人工备注","blue_eyes"],[this.targetB,"乙来源独立人工备注","aqua_eyes"]]) {
      await this.d.invoke("workspace_edit_source", { target, safeMode: true, edits: [{kind:"setNote",text:note}] });
      await this.d.invoke("workspace_edit_source_tags", { target, safeMode: true, edits: [{kind:"add",tag:{kind:"external",namespace:"general",name:external}}] });
    }
    await this.d.invoke("workspace_edit_source", { target: this.targetA, safeMode: true, edits: [{kind:"addToFolder",folderId:this.childA}] });
    const conditions = await this.d.invoke("workspace_resolve", { input: { conditions: [this.blue,this.aqua].map(id=>({any:[{kind:"tag",id,dismissed:[]}],negate:false})), exact:true }, lang:"zh-CN", safeMode:true });
    this.d.assert((await this.allPages(allScope, conditions)).total === 0, "split AND conditions across byte-identical providers cannot create a match");
    await this.d.invoke("workspace_edit_source_tags", { target:this.targetA, safeMode:true, edits:[{kind:"add",tag:{kind:"external",namespace:"general",name:"aqua_eyes"}}] });
    const matched = await this.allPages(allScope, conditions);
    this.d.assert(matched.total === 1 && matched.cards[0].sources.length === 2 && matched.cards[0].sources.find(source=>source.libraryId===this.b.id)?.matches===false, "one complete source makes exactly one card while retaining the other nonmatching source", matched);
    const parent = await this.local(this.a.id,this.folderA);
    const tree = await this.allPages({kind:"library",libraryId:this.a.id,scope:{kind:"folderTree",id:this.folderA}});
    this.d.assert(parent.total===tree.total && tree.cards.filter(item=>item.id===card.id).length===1, "a parent and child membership count the same original once", {parent:parent.total,tree:tree.total});
    await this.prefer(this.blue,"最贴切的蓝瞳"); await this.prefer(this.aqua,"水色瞳");
    this.removedAlias = {lang:"zh-CN",name:"本轮删除的蓝瞳别名"};
    await this.d.invoke("edit_tag_name",{catalogId:this.blue,edit:{kind:"addAlias",alias:this.removedAlias}});
    await this.d.invoke("edit_tag_name",{catalogId:this.blue,edit:{kind:"removeAlias",alias:this.removedAlias}});
    await this.current(this.a.id); await this.scope(); await this.clearSearch();
    if (!await this.d.exec("return document.querySelector('button.search-exact')?.getAttribute('aria-pressed')==='true';")) await this.readyClick("//button[contains(@class,'search-exact')]");
    await this.searchTag("最贴切的蓝瞳"); await this.searchTag("水色瞳");
    await until("real UI AND result",()=>this.d.exec("return document.querySelector('.wall')?.dataset.total==='1' && document.querySelectorAll('[aria-label=查找条件]>li').length===2;"));
    await this.d.screenshot("02-single-card-complete-source-match.png");
    this.state.sources={targetA:this.targetA,targetB:this.targetB,sealedA:this.sealedA,sealedB:this.sealedB,folderA:this.folderA,childA:this.childA,folderB:this.folderB}; this.save();
  }
  async sourceActions() {
    this.phase("inactive-source-pin-group-and-copy");
    const d=this.d;
    // The fixed bottom-right result cards cover the inspector's lower action row (r13); close them as a user would.
    await this.dismissImportResults();
    // Multi-source detail is now the 详情 inspector, opened from the card's “在 N 个图库” control.
    await this.readyClick(`//*[@role='option' and @data-id=${literal(this.visibleCard.id)}]//button[contains(@class,'card-sources') and starts-with(@aria-label,'在 ')]`);
    await this.d.enabled("//aside[@aria-label='详情']//section[@aria-label='图库来源']");
    d.assert(await d.exec("return [...document.querySelectorAll('[data-source-library-id] .workspace-source-path')].every(node=>node.textContent.trim()) && new Set([...document.querySelectorAll('[data-source-library-id] .workspace-source-path')].map(node=>node.textContent)).size===2;"),"same-name providers visibly show distinct path suffixes");
    await d.screenshot("02a-aggregated-card-sources.png");
    await this.readyClick(`//*[@data-source-library-id=${literal(this.b.id)}]//button[normalize-space()='整理此来源']`);
    await until("B inspection actually loaded",()=>d.exec("return document.querySelector('[aria-label=整理来源] textarea[aria-label=备注]')?.value==='乙来源独立人工备注';"));
    await this.sourceEditorLoaded("乙来源独立人工备注");
    await d.screenshot("02b-source-editor-loaded.png");
    await d.type("//*[@aria-label='整理来源']//textarea[@aria-label='备注']","乙来源经界面修改的备注");
    await this.readyClick("//*[@aria-label='整理来源']//button[normalize-space()='保存备注']");
    await until("B note saved",async()=>(await this.inspect(this.targetB)).detail.note.manual==="乙来源经界面修改的备注");
    d.assert((await this.inspect(this.targetA)).detail.note.manual==="甲来源独立人工备注"&&(await d.invoke("current_library")).id===this.a.id,"editing explicit inactive B leaves A curation and current provider intact");
    const pinsFile=join(d.data,"pins.json"); const before=existsSync(pinsFile)?JSON.parse(readFileSync(pinsFile,"utf8")).pins.map(pin=>pin.id):[];
    await this.readyClick("//*[@aria-label='整理来源']//fieldset//button[normalize-space()='钉住']");
    this.pinB=await until("real B pin persisted",()=>{if(!existsSync(pinsFile))return null;return JSON.parse(readFileSync(pinsFile,"utf8")).pins.find(pin=>!before.includes(pin.id));});
    d.assert(this.pinB.content.kind==="reference"&&this.pinB.content.libraryId===this.b.id&&this.pinB.content.imageId===this.targetB.imageId,"native pin retains the explicitly selected B original",this.pinB);
    await until("actual source pin window",async()=>(await d.invoke("get_all_windows",{},"window")).includes("pin-"+this.pinB.id));
    await d.closePin(this.pinB.id);
    d.assert(!(await d.invoke("get_all_windows",{},"window")).includes("pin-"+this.pinB.id),"Escape from the real B pin destroys that window before returning to main");
    // The pin changes the workspace revision; the inspector revalidates the source (as after copy). Wait for that real reload.
    await this.sourceEditorLoaded("乙来源经界面修改的备注");
    await d.enabled("//*[@aria-label='整理来源']//input[@aria-label='新参考组名称']");
    await d.type("//*[@aria-label='整理来源']//input[@aria-label='新参考组名称']","本轮乙来源参考组及需要自动换行的长名称");
    await this.readyClick("//*[@aria-label='整理来源']//fieldset//button[normalize-space()='加入组']");
    const group=await until("actual B source group",async()=>(await d.invoke("reference_groups",{},"desktop")).find(group=>group.name==="本轮乙来源参考组及需要自动换行的长名称"));
    this.referenceB=(await d.invoke("reference_group",{groupId:group.id},"desktop")).group;
    d.assert(this.referenceB.members.length===1&&this.referenceB.members[0].libraryId===this.b.id&&this.referenceB.members[0].imageId===this.targetB.imageId,"reference group keeps explicit B provider identity",this.referenceB);
    const beforeA=await this.inspect(this.targetA);
    await this.readyClick("//*[@aria-label='整理来源']//fieldset//button[normalize-space()='复制到…']");
    const copying=dialog("复制此来源");
    await this.chooseDestination(this.a.id,this.folderA,copying);await this.readyClick(`${copying}//button[normalize-space()='确认复制']`);
    await until("actual copy dialog closed",()=>d.exec("return !document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;",[copying]));
    d.assert((await this.inspect(this.targetA)).detail.note.manual===beforeA.detail.note.manual,"copying B into existing A preserves A's manual note");
    // The copy records B's tags as a non-manual source origin (T10: content snapshot and source record).
    // A's manual decisions (manual origins and rejections) must stay exactly as they were.
    const manualDecisions=image=>({manual:image.tags.filter(item=>item.origins.some(origin=>origin.kind==="manual")).map(item=>item.tag.id).sort(),rejected:JSON.stringify(image.rejected)});
    const afterA=await this.inspect(this.targetA);
    d.assert(JSON.stringify(manualDecisions(afterA.tags.image))===JSON.stringify(manualDecisions(beforeA.tags.image)),"copying B into existing A preserves A's manual tag decisions",{before:beforeA.tags.image,after:afterA.tags.image});
    // The copy notifies a new revision; the editor revalidates. Wait for that real reload to finish.
    const reloaded=await this.sourceEditorLoaded("乙来源经界面修改的备注");
    d.assert(reloaded.note==="乙来源经界面修改的备注"&&reloaded.source.includes(this.b.id),"after copy the source editor finishes reloading and still shows explicit B with its saved note",reloaded);
    await d.screenshot("02c-source-editor-after-copy-loaded.png");
    // 关闭来源 is now the inspector's 收起详情.
    await this.readyClick("//aside[@aria-label='详情']//button[@aria-label='收起详情']");
    await until("source inspector actually closed",()=>d.exec("return !document.querySelector('[aria-label=整理来源]')&&!document.querySelector('section[aria-label=图库来源]');"));
    await this.groupsPane();
    const packageDir=join(d.work,"参考组导出路径需要换行以保证侧栏仍能显示完整来源与操作");mkdirSync(packageDir,{recursive:true});
    this.packagePath=join(packageDir,"乙来源参考组.kinshoko-group");await d.pick(this.packagePath);
    // 导出参考组包 moved into each group card's “更多操作” menu.
    await this.readyClick(`//li[@data-id=${literal(this.referenceB.id)}]//button[@aria-label='更多操作']`);
    await this.readyClick("//*[@role='menu']//*[@role='menuitem' and normalize-space()='导出参考组包']");
    await until("actual reference package exists and export status rendered",()=>existsSync(this.packagePath)&&d.exec("return document.querySelector('.reference-groups')?.textContent.includes(arguments[0]);",[this.packagePath]));
    await d.screenshot("03-reference-sidebar-long-name-and-path.png");
    this.referenceA=await this.importPackage(this.a.id,this.folderA);
    d.assert(this.referenceA.members.every(member=>member.libraryId===this.a.id)&&this.referenceA.importedFromPackage,"package import binds the explicitly selected A provider",this.referenceA);
    d.assert((await this.inspect(this.targetA)).detail.note.manual===beforeA.detail.note.manual,"package import also preserves the already curated A manual note");
    d.assert((await d.invoke("current_library")).id===this.a.id,"pin, group, cross-provider copy and package import keep current A");
    this.state.references={pinB:this.pinB,referenceB:this.referenceB,referenceA:this.referenceA,packagePath:this.packagePath};this.save();
  }
  // Source editor has finished its inspection: no loading status, note and actions rendered.
  sourceEditorLoaded(note) {
    // The explicit source is the editor's own libraryId/imageId identity and the pressed source segment.
    return until("source editor finished loading",()=>this.d.exec("const editor=document.querySelector('[aria-label=整理来源]');if(!editor||editor.textContent.includes('正在读取该来源…'))return null;const area=editor.querySelector('textarea[aria-label=备注]');if(area?.value!==arguments[0]||![...editor.querySelectorAll('fieldset button')].some(b=>b.textContent.trim()==='钉住'))return null;const pressed=[...document.querySelectorAll('[aria-label=当前操作的来源记录] [aria-pressed=true]')];return pressed.length===1?{note:area.value,source:editor.getAttribute('title')??'',segment:pressed[0].textContent.trim(),text:editor.textContent.slice(0,400)}:null;",[note]));
  }
  // Close every finished import result card (after each close the next remaining receipt shows).
  async dismissImportResults() {
    for (let closed = 0; await this.d.exec("const c=document.querySelector('section[aria-label=导入结果]');return !!c&&c.getClientRects().length>0;"); closed++) {
      if (closed >= 20) throw Error("Import result cards did not close");
      const before = (await this.d.invoke("import_tasks")).length;
      await this.readyClick("//section[@aria-label='导入结果']//button[@aria-label='关闭导入结果']");
      await until("one actual import receipt dismissed", async () => (await this.d.invoke("import_tasks")).length < before);
    }
  }
  async groupsPane() {
    if (!await this.d.exec("return document.querySelector('button[aria-label=参考组]')?.getAttribute('aria-expanded')==='true';"))await this.readyClick("//button[@aria-label='参考组']");
    await this.d.enabled("//section[@aria-label='参考组']//button[normalize-space()='导入参考组包']");
  }
  // 导入参考组包 opens the shared save-destination dialog; confirming also makes it the next save target.
  async importPackage(libraryId,folderId) {
    const d=this.d;await this.groupsPane();
    const beforeGroups=new Set((await d.invoke("reference_groups",{},"desktop")).map(group=>group.id));
    await this.readyClick("//section[@aria-label='参考组']//button[normalize-space()='导入参考组包']");
    const importing=dialog("导入参考组包");
    await this.chooseDestination(libraryId,folderId,importing);await d.pick(this.packagePath);await this.readyClick(`${importing}//button[normalize-space()='选择参考组包并导入']`);
    const imported=await until("new imported reference group",async()=>(await d.invoke("reference_groups",{},"desktop")).find(group=>!beforeGroups.has(group.id)));
    await until("package dialog closed",()=>d.exec("return !document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;",[importing]));
    return (await d.invoke("reference_group",{groupId:imported.id},"desktop")).group;
  }
  async latePickerAndRules() {
    this.phase("real-monitor-picker-and-personal-rule"); const d=this.d;
    await this.settings("标签");await this.tagView("分组");await d.events(["workspace-changed","library-event"]);
    const section="//section[@aria-label='全局标签分组']";
    await this.readyClick(`${section}//button[@aria-label='新建标签分组']`);
    await d.type(`${section}//input[@aria-label='新标签分组名称']`,"跨库眼睛");await this.readyClick(`${section}//button[normalize-space()='建立']`);
    const afterCreation=await d.invoke("workspace_status",{safeMode:true});
    await until("real monitor settles the actual group creation",async()=>(await d.readEvents()).some(event=>event.payload.event==="workspace-changed"&&event.payload.payload.revision===afterCreation.revision));
    await this.readyClick(`${section}//button[@aria-label='给“跨库眼睛”加标签']`);
    await d.type(`${section}//input[@aria-label='挑一个统一标签']`,"最贴切");
    const typedAt=await d.exec("window.__T20_PICKER_NODE__=document.querySelector('section[aria-label=全局标签分组] input[aria-label=挑一个统一标签]');return Date.now();");
    d.assert(await d.exec("const node=window.__T20_PICKER_NODE__;return node?.value==='最贴切'&&node===document.activeElement;"),"the real tag picker is focused and contains input before the catalog change",{typedAt});
    const beforeMutation=await d.invoke("workspace_status",{safeMode:true});
    const monitorAlias={lang:"zh-CN",name:"本轮监视器触发的分发别名"};
    await d.invoke("edit_tag_name",{catalogId:this.parted,edit:{kind:"addAlias",alias:monitorAlias}});
    const afterMutation=await d.invoke("workspace_status",{safeMode:true});
    d.assert(afterMutation.revision!==beforeMutation.revision,"a real unrelated catalog alias changes the workspace after picker input",{beforeMutation,afterMutation,monitorAlias});
    const late=await until("actual changed revision arrives after typing",async()=>(await d.readEvents()).find(event=>event.payload.event==="workspace-changed"&&event.payload.payload.revision===afterMutation.revision&&event.at>typedAt));
    await until("fresh actual candidate after monitor refresh",()=>d.exec("const field=document.querySelector('section[aria-label=全局标签分组] input[aria-label=挑一个统一标签]');return field?.value==='最贴切'&&field===window.__T20_PICKER_NODE__&&field===document.activeElement&&document.querySelector('section[aria-label=全局标签分组] .sidebar-pick-tag [role=option]')?.textContent.includes('最贴切的蓝瞳');"));
    d.assert(true,"real post-input catalog notification preserves the same focused tag picker and typed input",{typedAt,late,monitorAlias});
    await d.key("\uE007");
    const group=await until("preserved picker commits a real member",async()=>(await d.invoke("shared_tag_groups",{lang:"zh-CN",safeMode:true})).find(group=>group.name==="跨库眼睛"&&group.tags.some(member=>member.tag.id===this.blue)));
    this.sharedGroup=group.id;
    await d.invoke("edit_shared_tag_group",{edit:{kind:"addMembers",groupId:group.id,tagIds:[this.aqua]},safeMode:true});
    await until("committed member rendered in the same group editor",()=>d.exec("const group=[...document.querySelectorAll('section[aria-label=全局标签分组] [role=group]')].find(node=>node.getAttribute('aria-label')==='跨库眼睛');return !!group&&group.textContent.includes('最贴切的蓝瞳');"));
    await d.screenshot("04-preserved-picker-and-live-global-settings.png");
    await d.invoke("edit_shared_approx",{edit:{kind:"set",rules:[{a:this.blue,b:this.aqua,relation:"similar"}]},safeMode:true});
    // Personal rules live on the 相近 view of the same 标签 tab.
    await this.tagView("相近");
    await until("actual personal rule table has completed loading",()=>d.exec("const table=document.querySelector('table[aria-label=个人近似对应表]');return table?.textContent.includes('最贴切的蓝瞳')&&table.textContent.includes('水色瞳')&&!document.querySelector('section[aria-label=全局个人近似规则]')?.textContent.includes('正在读取个人近似规则…');"));
    await d.screenshot("04b-live-global-personal-rule.png");await this.closeSettings();
    this.state.shared={groupId:this.sharedGroup,blue:this.blue,aqua:this.aqua,parted:this.parted,typedAt,late,afterCreation,beforeMutation,afterMutation,monitorAlias};this.save();
  }
  async fixedImportOwner() {
    this.phase("running-import-owner-vs-browse-current-next-save");const d=this.d;
    await this.current(this.a.id);await this.clearSearch();await this.scope(this.a.id,this.folderA);
    const id=await this.beginImport(Array(this.fixture.longImportCount).fill(this.fixture.inputs.incoming.path),this.b.id,this.folderB);
    const running=await until("genuinely pending partially progressed import",async()=>{const task=await this.task(id);return task&&!task.report&&task.progress.done>0&&task.progress.done<task.progress.total?task:null;});
    await this.current(this.b.id);await this.scope(this.a.id,this.folderA);
    // #98: while an import runs, the import dialog cannot open, so the shared next-save target is
    // changed by a real save into A/folderA through the same destination dialog (导入参考组包).
    const nextSave=await this.importPackage(this.a.id,this.folderA);
    d.assert(nextSave.members.length>0&&nextSave.members.every(member=>member.libraryId===this.a.id),"a real save during the running task goes to the newly chosen next-save A",nextSave);
    await this.scope(this.a.id,this.folderA);
    const during=await this.task(id);
    d.assert(during&&!during.report&&during.destination.libraryId===this.b.id&&during.destination.folderId===this.folderB,"actual pending task retains B while current B, browsing A and next-save A differ",{before:running,during,nextSave:{groupId:nextSave.id,members:nextSave.members}});
    d.assert(await d.exec("const card=document.querySelector('section[aria-label=导入进度]');return !!card&&card.getClientRects().length>0&&card.textContent.includes('放到 同名资料库 / 同名目录');"),"visible running receipt reports the fixed original provider and folder");
    d.assert(await d.invoke("cancel_import",{libraryId:this.a.id,taskId:id}).then(()=>false,()=>true),"a real pending task rejects cancellation through the wrong provider");
    await d.screenshot("05-fixed-owner-with-independent-browse-and-save.png");
    // r3 observed ~14 entries/s for this 2000-entry debug-build task; 90s was a harness bound, not a product limit.
    const completed=await this.finish(id,900000);this.receipts.push(completed);
    d.assert(!completed.report.cancelled&&completed.report.items.length===this.fixture.longImportCount,"same task completes every submitted entry after current, scope and next-save changes",completed);
    const source=async(libraryId)=>(await this.local(libraryId)).cards.find(card=>card.width===this.fixture.inputs.incoming.width&&card.height===this.fixture.inputs.incoming.height);
    d.assert(await source(this.b.id)&&!await source(this.a.id),"incoming original exists only in submitted B, never in browse/next-save A");
    await this.current(this.a.id);this.state.runningImport={before:running,during,completed,nextSave:{groupId:nextSave.id,via:"导入参考组包",members:nextSave.members}};this.save();
  }
  async runtimeAndUpdateUI() {
    this.phase("actual-runtime-diagnostics-and-manual-update-ui");const d=this.d;
    // 本机运行时 is now 设置 › 诊断 › 运行环境; the recheck button is 检查 and success is the 正常 status.
    await this.settings("诊断");
    const section="//section[@aria-label='运行环境']";
    await this.readyClick(`${section}//button[normalize-space()='检查']`);
    await until("actual current-window capability check settled",()=>d.exec("const node=document.querySelector('section[aria-label=运行环境]');return node&&!node.textContent.includes('检查中')&&node.textContent.includes('正常')&&!node.querySelector('[role=alert]')&&!node.querySelector('button:disabled');"));
    await d.exec("document.querySelector('section[aria-label=运行环境]').scrollIntoView({block:'center'});");
    const runtime=await d.exec("const node=document.querySelector('section[aria-label=运行环境]');return {text:node.textContent,rect:node.getBoundingClientRect().toJSON()};");
    d.assert(/WebView2 [0-9]+\./.test(runtime.text)&&runtime.text.includes("不代表颜色还原已通过"),"actual WebView2 and current-window capability results retain the separate color-quality boundary",runtime);
    await d.screenshot("10b-actual-runtime-capabilities.png");
    await this.readyClick("//section[@aria-label='设置']//*[normalize-space()='诊断信息']/ancestor::*[.//button[normalize-space()='查看']][1]//button[normalize-space()='查看']");
    const diagnostics=await until("real diagnostics contain actual decoding and drawing checks",()=>d.exec("const text=document.querySelector('pre[aria-label=诊断信息]')?.textContent;return text?.includes('内置 PNG 解码：完成')&&text.includes('钉图二维绘制与基础像素读回：完成')?text:null;"));
    // Scroll the real text range; keep both ends of the capabilities block inside each actual clip.
    const expose="const pre=document.querySelector('pre[aria-label=诊断信息]'),text=pre.textContent,start=text.indexOf('[运行时能力]'),end=text.indexOf('[显示器]',start);if(start<0||end<0)throw Error('actual capability section missing');const range=document.createRange();range.setStart(pre.firstChild,start);range.setEnd(pre.firstChild,end);pre.scrollIntoView({block:'center'});const before=range.getBoundingClientRect(),box=pre.getBoundingClientRect();pre.scrollTop+=(before.top+before.bottom-box.top-box.bottom)/2;return true;";
    await d.exec(expose);
    const diagnosticVisibility=await until("whole actual capability text block visible",()=>d.exec("const pre=document.querySelector('pre[aria-label=诊断信息]'),text=pre.textContent,start=text.indexOf('[运行时能力]'),end=text.indexOf('[显示器]',start),range=document.createRange();range.setStart(pre.firstChild,start);range.setEnd(pre.firstChild,end);const rect=range.getBoundingClientRect();let top=0,bottom=innerHeight,left=0,right=innerWidth;for(let node=pre;node;node=node.parentElement){const style=getComputedStyle(node),box=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}}return rect.top>=top&&rect.bottom<=bottom&&rect.left>=left&&rect.right<=right?{range:rect.toJSON(),clip:{top,bottom,left,right},text:text.slice(start,end)}:null;"));
    d.save("actual-diagnostics.json",{text:diagnostics,visibility:diagnosticVisibility});await d.screenshot("10c-actual-diagnostics-visible-capability-block.png");
    const update=await d.invoke("update_status",{},null);
    d.assert(update.state==="manual"&&update.message==="当前使用安装包手动更新。","the actual build reports manual package updating without a repository-visibility claim",update);
    // 设置 › 更新: the manual steps are behind 查看步骤.
    await this.settings("更新");
    await this.readyClick("//section[@aria-label='设置']//button[normalize-space()='查看步骤']");
    const updateUI=await until("actual complete manual update instructions visibly rendered",()=>d.exec(`
const message=[...document.querySelectorAll('section[aria-label=设置] p')].find(node=>node.textContent.trim()===arguments[0]),steps=message?.nextElementSibling;
if(!steps?.textContent.includes('从托盘退出 Kinshoko 后，运行开发者提供的新版安装包'))return null;
steps.scrollIntoView({block:'center'});
const a=message.getBoundingClientRect(),b=steps.getBoundingClientRect(),whole={top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom),left:Math.min(a.left,b.left),right:Math.max(a.right,b.right)};
let top=0,bottom=innerHeight,left=0,right=innerWidth;
for(let node=message.parentElement;node;node=node.parentElement){const style=getComputedStyle(node),box=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}}
if(whole.top<top||whole.bottom>bottom||whole.left<left||whole.right>right)return null;
return {message:message.textContent,steps:steps.textContent,visibility:{whole,clip:{top,bottom,left,right},message:a.toJSON(),steps:b.toJSON()},buttons:[...document.querySelectorAll('section[aria-label=设置] button')].map(node=>node.textContent.trim())};
`,[update.message]));
    d.assert(!updateUI.buttons.includes("检查更新")&&!updateUI.buttons.includes("安装并重启")&&updateUI.steps.includes("安装到原位置")&&updateUI.steps.includes("继续使用已有图库、设置、参考组和钉图"),"formal settings show the complete supported manual-update steps",updateUI);
    await d.screenshot("10d-manual-update-instructions.png");
    await this.closeSettings();this.state.runtimeAndUpdate={runtime,diagnosticVisibility,update,updateUI,colorGate:"independent-existing-results-unchanged"};this.save();
  }
  async strictAdultAndConsent() {
    this.phase("strict-known-adult-and-receipt-consent");const d=this.d;
    await d.invoke("workspace_edit_source",{target:this.sealedB,safeMode:true,edits:[{kind:"setRating",rating:"explicit"}]});
    const a=await this.local(this.a.id),b=await this.local(this.b.id),all=await this.allPages();
    d.assert(!a.cards.some(card=>card.id===this.sealedA.contentId)&&!b.cards.some(card=>card.id===this.sealedA.contentId)&&!all.cards.some(card=>card.id===this.sealedA.contentId),"known Adult B vetoes byte-identical Unknown A even in A-only scope",{a:a.total,b:b.total,all:all.total,sealed:this.sealedA.contentId});
    d.assert(a.cards.some(card=>card.width===this.fixture.inputs.unknown.width&&card.height===this.fixture.inputs.unknown.height),"an unrelated genuinely Unknown control stays visible");
    d.assert(await this.inspect(this.sealedA).then(()=>false,()=>true),"hidden Unknown A cannot be opened through a stale aggregate source target");
    await this.scope(this.a.id,this.folderA);const receipt=await this.import([this.fixture.inputs.sealed.path],this.a.id,this.folderA);
    d.assert(receipt.report.sealedDuplicates&&receipt.report.privateSummary&&receipt.report.items.length===0&&receipt.progress.done===0&&receipt.progress.total===0,"default real sealed receipt conceals successful item IDs and exact counts",receipt);
    // The sealed prompt is a bottom-right card: “有成人图与已有的重复” with 看看.
    // The preview re-veils on any workspace change by design; let the import's change burst end first.
    await this.settled();
    await until("actual sealed consent prompt",()=>d.exec("const card=document.querySelector('section[aria-label=成人图重复]');return !!card&&card.getClientRects().length>0&&card.textContent.includes('有成人图与已有的重复');"));
    d.assert(!await d.exec("return !!document.querySelector('dialog.sealed-import-preview');"),"no sealed preview exists before explicit consent");
    await d.screenshot("06-default-scoped-sealed-prompt.png");
    await this.readyClick("//section[@aria-label='成人图重复']//button[@aria-label='看看本次重复项']");
    await until("actual one receipt duplicate decoded",()=>d.exec("const images=[...document.querySelectorAll('dialog.sealed-import-preview img')];return images.length===1&&images[0].complete&&images[0].naturalWidth>0;"));
    d.assert(await d.invoke("safe_mode")===true,"receipt-scoped consent keeps global safe mode on");
    await d.screenshot("07-one-receipt-consent.png");
    // The preview is a modal <dialog>: nothing behind it can be clicked. As the old harness did with a JS
    // select change, change the current library with synthetic events on the library menu behind the modal.
    await this.currentBehindModal(this.b.id);
    await until("current provider change re-veils decoded preview",()=>d.exec("return !document.querySelector('dialog.sealed-import-preview');"));
    await this.shownCurrent(this.b.id);
    await this.current(this.a.id);
    d.assert(!await d.exec("return !!document.querySelector('dialog.sealed-import-preview img');"),"returning to A requires fresh consent instead of reviving decoded content");
    this.sealedReceipt=receipt;this.state.sealed={receipt};this.save();
  }
}
