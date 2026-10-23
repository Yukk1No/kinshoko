// CombinationWorkflow methods for source actions and package transfer; spec78-combination-workflow.mjs mixes them into the class.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { literal, dialog } from "./spec78-combination-workflow.xpath.mjs";

export const sourcesPhases = {
  async sourceActions() {
    this.phase("inactive-source-pin-group-and-copy");
    const d=this.d;
    // Multi-source detail is now the 详情 inspector, opened from the card's “在 N 个图库” control,
    // a sibling of the card option (no focusable children inside an option).
    d.assert(await d.exec(`return !document.querySelector('[role=option] button, [role=option] [tabindex]');`),"card options have no focusable children");
    await this.readyClick(`//div[@role='listbox' and @aria-label='图片墙']//button[contains(@class,'card-sources') and @data-card=${literal(this.visibleCard.id)} and starts-with(@aria-label,'在 ')]`);
    await this.d.enabled("//aside[@aria-label='详情']//section[@aria-label='图库来源']");
    d.assert(await d.exec("return [...document.querySelectorAll('[data-source-library-id] .workspace-source-path')].every(node=>node.textContent.trim()) && new Set([...document.querySelectorAll('[data-source-library-id] .workspace-source-path')].map(node=>node.textContent)).size===2;"),"same-name providers visibly show distinct path suffixes");
    await d.screenshot("02a-aggregated-card-sources.png");
    await this.readyClick(`//*[@data-source-library-id=${literal(this.b.id)}]//button[normalize-space()='整理此来源']`);
    await until("B inspection actually loaded",()=>d.exec("return document.querySelector('[aria-label=整理来源] textarea[aria-label=备注]')?.value==='乙来源独立人工备注';"));
    await this.sourceEditorLoaded("乙来源独立人工备注");
    await d.screenshot("02b-source-editor-loaded.png");
    await d.type("//*[@aria-label='整理来源']//textarea[@aria-label='备注']","乙来源经界面修改的备注");
    await this.readyClick("//*[@aria-label='整理来源']//button[@aria-label='保存备注']");
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
  },
  // Source editor has finished its inspection: no loading status, note and actions rendered.
  sourceEditorLoaded(note) {
    // The explicit source is the editor's own libraryId/imageId identity and the pressed source segment.
    return until("source editor finished loading",()=>this.d.exec("const editor=document.querySelector('[aria-label=整理来源]');if(!editor||editor.textContent.includes('正在读取该来源…'))return null;const area=editor.querySelector('textarea[aria-label=备注]');if(area?.value!==arguments[0]||![...editor.querySelectorAll('fieldset button')].some(b=>b.textContent.trim()==='钉住'))return null;const pressed=[...document.querySelectorAll('[aria-label=当前操作的来源记录] [aria-pressed=true]')];return pressed.length===1?{note:area.value,source:editor.getAttribute('title')??'',segment:pressed[0].textContent.trim(),text:editor.textContent.slice(0,400)}:null;",[note]));
  },
  // Close every finished import result card (after each close the next remaining receipt shows).
  async dismissImportResults() {
    for (let closed = 0; await this.d.exec("const c=document.querySelector('section[aria-label=导入结果]');return !!c&&c.getClientRects().length>0;"); closed++) {
      if (closed >= 20) throw Error("Import result cards did not close");
      const before = (await this.d.invoke("import_tasks")).length;
      await this.readyClick("//section[@aria-label='导入结果']//button[@aria-label='关闭导入结果']");
      await until("one actual import receipt dismissed", async () => (await this.d.invoke("import_tasks")).length < before);
    }
  },
  async groupsPane() {
    if (!await this.d.exec("return document.querySelector('button[aria-label=参考组]')?.getAttribute('aria-expanded')==='true';"))await this.readyClick("//button[@aria-label='参考组']");
    await this.d.enabled("//section[@aria-label='参考组']//button[normalize-space()='导入参考组包']");
  },
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
};
