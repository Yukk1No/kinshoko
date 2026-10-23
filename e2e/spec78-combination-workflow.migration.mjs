// CombinationWorkflow methods for registration, migration, import and curation; spec78-combination-workflow.mjs mixes them into the class.
import { until } from "./spec78-combination-driver.mjs";
import { literal, allScope, dialog } from "./spec78-combination-workflow.xpath.mjs";

export const migrationPhases = {
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
  },
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
    if (!await this.d.exec("return document.querySelector('button.k-exact')?.getAttribute('aria-pressed')==='true';")) await this.readyClick("//button[@aria-label='精确查找']");
    await this.searchTag("最贴切的蓝瞳"); await this.searchTag("水色瞳");
    await until("real UI AND result",()=>this.d.exec("return document.querySelector('.wall')?.dataset.total==='1' && document.querySelectorAll('[aria-label=查找条件]>li').length===2;"));
    await this.d.screenshot("02-single-card-complete-source-match.png");
    this.state.sources={targetA:this.targetA,targetB:this.targetB,sealedA:this.sealedA,sealedB:this.sealedB,folderA:this.folderA,childA:this.childA,folderB:this.folderB}; this.save();
  }
};
