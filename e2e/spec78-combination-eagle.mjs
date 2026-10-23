// Same-session Eagle combination, adapted from the real T14 wizard harness.
// Importing this module never starts a process. Input writes name this round's owned source only.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { literal, blank, eagleDialog } from "./spec78-combination-workflow.mjs";
import { fileRecord } from "./spec78-combination-preflight.mjs";

export async function eagleReimportCombination(workflow) {
  const d=workflow.d,{eagle,inputs}=workflow.fixture,b=workflow.b;
  workflow.phase("same-session-eagle-deletion-reimport");
  const originalRoot=resolve(workflow.fixture.root)+sep;
  for(const path of [eagle.original.path,eagle.itemMetadata.path,eagle.libraryMetadata.path])if(!resolve(path).startsWith(originalRoot))throw Error("Eagle source write escaped this round's generated fixture");
  const aBefore=(await workflow.local(workflow.a.id)).cards.map(card=>card.id).sort(),aNote=(await workflow.inspect(workflow.targetA)).detail.note.manual;
  await workflow.current(b.id);
  const folder=await d.invoke("create_folder",{libraryId:b.id,name:"Eagle 重导本轮",parent:null});
  await workflow.scope(b.id,folder);await workflow.clearSearch();
  const detail=imageId=>d.invoke("image",{libraryId:b.id,imageId});
  const page=()=>workflow.local(b.id,folder);
  const tasks=[];
  // #98: the import popup is gone; an open menu is closed so the wall is reachable again.
  const closeImport=()=>workflow.closeMenu();
  // The Eagle choice is the 删过的图 radio cards (继续跳过 / 这次也导入) in the 从 Eagle 导入 dialog.
  const policy=()=>d.exec("return !!document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;",[`${eagleDialog}//input[@type='radio' and @name='eagle-deleted-content']`]);
  const defaults=()=>d.exec("return [...document.querySelectorAll('input[type=radio][name=eagle-deleted-content]')].map(node=>node.checked);");
  const prepare=async()=>{
    await d.pick(eagle.sourceParent);
    await workflow.readyClick("//button[@aria-label='导入']");
    await workflow.readyClick("//*[@role='menu']//*[@role='menuitem' and normalize-space()='文件夹']");
    await until("actual Eagle deletion choice",policy);
    await workflow.chooseDestination(b.id,folder,eagleDialog);
    const choices=await defaults();d.assert(JSON.stringify(choices)==="[true,false]","a fresh Eagle wizard defaults to remembering deleted same content",choices);
  };
  const finish=async()=>{
    const oldTasks=new Set((await d.invoke("import_tasks")).map(task=>task.taskId));
    await workflow.readyClick(`${eagleDialog}//button[normalize-space()='开始导入']`);
    const started=await until("actual new Eagle task",async()=>(await d.invoke("import_tasks")).find(task=>!oldTasks.has(task.taskId)));
    d.assert(started.destination.libraryId===b.id&&started.destination.folderId===folder,"the Eagle task owns explicit B and its own selected folder",started.destination);
    const task=await workflow.finish(started.taskId);
    d.assert(task.report.fromEagle&&!task.report.cancelled&&task.warnings.length===0,"the real Eagle task finishes and publishes definitions",{taskId:task.taskId,report:task.report,warnings:task.warnings});
    await until("actual finished Eagle report and tag step",async()=>!await policy()&&await d.exec("return Boolean(document.querySelector('[aria-label=\"导入结果\"]'))&&Boolean(document.querySelector('[aria-label=\"标签的外部对应\"]'));"));
    await workflow.readyClick("//*[@aria-label='标签的外部对应']/header/button");
    const text=await d.exec("return document.querySelector('[aria-label=\"导入结果\"]')?.textContent;");
    tasks.push({task,text});workflow.receipts.push(task);workflow.save();return {task,text};
  };
  const cardFor=async imageId=>until("actual B card for Eagle source "+imageId,async()=>(await page()).cards.find(card=>card.sources.some(source=>source.libraryId===b.id&&source.imageId===imageId)));
  const select=async card=>{
    // A new revision re-reads the wall (it keeps a selection that still exists); select only after the
    // import's event burst ends so the click lands on the settled card.
    await closeImport();await workflow.settled();
    await d.controlClick(`//*[@role='option' and @data-id=${literal(card.id)}]`);
    await until("exactly one real Eagle card selected",()=>d.exec("return document.querySelector('.selbar-host [role=toolbar][aria-label=已选参考图操作] .selection-count')?.textContent==='已选 1 张';"));
  };
  // B is current here, so its recycle bin is the sidebar foot entry.
  const trashScope=async()=>{
    d.assert((await d.invoke("current_library"))?.id===b.id,"the Eagle recycle-bin entry belongs to current B");
    await workflow.trash(b.id);
  };
  const selbar="//div[contains(@class,'selbar-host')]//*[@role='toolbar' and @aria-label='已选参考图操作']";
  const trashPage=()=>workflow.allPages({kind:"library",libraryId:b.id,scope:{kind:"trash"}},blank,true);
  const softDelete=async imageId=>{
    await workflow.scope(b.id,folder);await select(await cardFor(imageId));await workflow.readyClick(`${selbar}//button[normalize-space()='删除']`);
    await until("actual Eagle source moved to recycle bin",async()=>(await detail(imageId)).deletedAt!==null);
  };
  const purge=async imageId=>{
    await softDelete(imageId);await trashScope();
    const card=await until("actual Eagle B trash card",async()=>(await trashPage()).cards.find(card=>card.sources.some(source=>source.libraryId===b.id&&source.imageId===imageId)));
    await select(card);await workflow.readyClick(`${selbar}//button[normalize-space()='永久删除…']`);
    await workflow.readyClick("//*[@role='alertdialog' and @aria-label='永久删除']//button[normalize-space()='确认永久删除']");
    await until("Eagle source really purged",async()=>await detail(imageId).then(()=>false,()=>true)&&(await trashPage()).total===0);
    await workflow.scope(b.id,folder);
  };

  await prepare();const initial=await finish();
  const first=initial.task.report.items.find(item=>item.outcome.kind==="imported")?.outcome.imageId;
  d.assert(first&&(await page()).total===1,"the default Eagle wizard first imports the new source into B",{first,report:initial.task.report});
  await purge(first);
  await prepare();const skipped=await finish();
  d.assert(skipped.text.includes("删过的图已跳过。")&&skipped.task.report.items.some(item=>item.outcome.kind==="skippedDeleted")&&(await page()).total===0,"same-session default reimport skips permanently deleted identical Eagle content",skipped);
  await d.screenshot("05b-eagle-default-skip.png");

  // 重新选择永久删除重导策略… is now the result card's 这次也导入… link; it reopens the same choice.
  await workflow.readyClick("//section[@aria-label='导入结果']//button[normalize-space()='这次也导入…']");await until("real change-policy wizard",policy);
  d.assert(JSON.stringify(await defaults())==="[true,false]","reopened Eagle policy starts with the default choice");
  await workflow.chooseDestination(b.id,folder,eagleDialog);
  const allowThis=`${eagleDialog}//label[.//span[normalize-space()='这次也导入']]/input[@type='radio']`;
  await workflow.readyClick(allowThis);await until("this-import-only choice checked",()=>d.exec("return document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue?.checked===true;",[allowThis]));
  const allowed=await finish(),allowedId=allowed.task.report.items.find(item=>["imported","newVersion"].includes(item.outcome.kind))?.outcome.imageId;
  d.assert(allowedId&&allowedId!==first&&(await page()).total===1,"explicit allow-this-import recreates the same bytes with a new local source ID",{first,allowedId,report:allowed.task.report});
  await softDelete(allowedId);
  await prepare();const trashDuplicate=await finish();
  const stillDeleted=await detail(allowedId);
  d.assert(trashDuplicate.text.includes("有图在回收站里，保持删除。")&&stillDeleted.deletedAt!==null&&(await page()).total===0,"Eagle reimport keeps an existing recycle-bin duplicate deleted",trashDuplicate);
  d.assert(!trashDuplicate.text.includes("test")&&!/回收站里.*\d/.test(trashDuplicate.text),"the recycle-bin duplicate prompt omits the source name and duplicate count",trashDuplicate.text);
  await d.screenshot("05c-eagle-trash-not-auto-restored.png");
  // 前往回收站恢复 is now 去回收站; B is current, so its recycle bin is the sidebar foot entry.
  await workflow.readyClick("//section[@aria-label='导入结果']//button[normalize-space()='去回收站']");
  await until("restore entry selected B's actual recycle bin",async()=>(await d.invoke("current_library"))?.id===b.id&&d.exec("return !!document.querySelector('nav[aria-label=查找范围] .side-foot button[aria-current=page]')?.getAttribute('aria-label')?.startsWith('回收站 · ');"));
  const trashCard=await until("actual deleted source before explicit restore",async()=>(await trashPage()).cards.find(card=>card.sources.some(source=>source.imageId===allowedId&&source.libraryId===b.id)));
  await select(trashCard);await workflow.readyClick(`${selbar}//button[normalize-space()='恢复']`);
  await until("only an explicit Restore action restores the Eagle source",async()=>(await detail(allowedId)).deletedAt===null);
  await purge(allowedId);

  const before={original:fileRecord(eagle.original.path),metadata:fileRecord(eagle.itemMetadata.path)};
  copyFileSync(inputs.eagleNew.path,eagle.original.path);
  const metadata=JSON.parse(readFileSync(eagle.itemMetadata.path,"utf8"));
  Object.assign(metadata,{size:inputs.eagleNew.bytes,width:inputs.eagleNew.width,height:inputs.eagleNew.height});
  writeFileSync(eagle.itemMetadata.path,JSON.stringify(metadata));
  const changedInput={before,after:{original:fileRecord(eagle.original.path),metadata:fileRecord(eagle.itemMetadata.path)}};
  d.assert(changedInput.after.original.sha256===inputs.eagleNew.sha256&&changedInput.after.original.sha256!==before.original.sha256,"only this round's owned Eagle item changes to the pre-hashed new content version",changedInput);
  await prepare();const newVersion=await finish();
  const newId=newVersion.task.report.items.find(item=>["imported","newVersion"].includes(item.outcome.kind))?.outcome.imageId;
  const changed=newId?await detail(newId):null;
  d.assert(newId&&newId!==allowedId&&changed.width===310&&changed.height===130&&(await page()).total===1,"the later default wizard imports new bytes of the same Eagle item as a new content version",{newId,detail:changed,report:newVersion.task.report});
  d.assert(JSON.stringify((await workflow.local(workflow.a.id)).cards.map(card=>card.id).sort())===JSON.stringify(aBefore)&&(await workflow.inspect(workflow.targetA)).detail.note.manual===aNote,"all Eagle deletion choices affect B without changing A's visible originals or manual note");
  d.assert((await d.invoke("registered_libraries")).length===2&&await d.invoke("safe_mode")===true,"Eagle checks remain in the same two-provider session with global safe mode on");
  await workflow.current(workflow.a.id);await workflow.scope();await workflow.clearSearch();await closeImport();
  workflow.state.eagle={reusedFrom:eagle.reusedFrom,reusedSourceSha256:eagle.reusedSourceSha256,destination:{libraryId:b.id,folderId:folder},first,allowedId,newId,changedInput,tasks};
  workflow.save();
}
