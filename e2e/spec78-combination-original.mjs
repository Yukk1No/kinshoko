// T20 original-region stage. Import-safe: no desktop/process/clipboard observation on import.
// Reuses fixed T16/T17 public capture contracts and their granted native observers.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { literal, named } from "./spec78-combination-workflow.mjs";
import { fileRecord } from "./spec78-combination-preflight.mjs";
import { originalProbes } from "./spec78-combination-original.probes.mjs";
import { originalCapture, sameRect } from "./spec78-combination-original.capture.mjs";

export const ORIGINAL_CONTRACT_SOURCE="1d188e52a9639319dbaf90de9fe46a9a6fcea9b3";
const originalHelpers=["e2e/native-wall-observe.py","e2e/native-wall-pixels.py","e2e/native-clipboard-observe.py","e2e/spec78-combination-original-pixels.py"];

// Deliberately reject the old partial product even after this module has been added.
// This gate runs before KnownFolder preservation, WebDriver boot or any native observer.
export function requireFinalOriginalSource(source) {
  if(!/^[0-9a-f]{40}$/.test(source??""))throw Error("An exact final original-capture build source is required");
  const check=spawnSync("git",["merge-base","--is-ancestor",ORIGINAL_CONTRACT_SOURCE,source],{encoding:"utf8",windowsHide:true});
  if(check.status!==0)throw Error("The actual build must first integrate the reviewed T17 original-capture source "+ORIGINAL_CONTRACT_SOURCE+": "+check.stderr);
  return {requiredAncestor:ORIGINAL_CONTRACT_SOURCE,actualBuildSource:source,exit:check.status};
}
export function checkOriginalPreparation(plan) {
  const source=requireFinalOriginalSource(plan.build?.source),helpers=Object.fromEntries(originalHelpers.map(path=>{
    const actual=fileRecord(path),recorded=plan.observation?.files?.[path];
    if(recorded?.bytes!==actual.bytes||recorded?.sha256!==actual.sha256)throw Error("The native plan must freeze the actual original observer/oracle: "+path);
    return [path,actual];
  }));
  return {source,helpers,nativeExecuted:false};
}

export async function originalCombination(workflow,plan) {
  const d=workflow.d,fixture=workflow.fixture,original=fixture.inputs.visible,session=d.session;
  workflow.phase("same-session-original-region");
  const state={status:"running",session,providers:[workflow.a.id,workflow.b.id],preparation:checkOriginalPreparation(plan),samples:[],virtual:null,reflow:null,closedPin:null,invalidSource:null};
  workflow.state.original=state;
  const save=()=>workflow.save();
  const desktop=(name,args={})=>d.invoke(name,args,"desktop");
  const native=(name,label="main")=>d.invoke(name,{label},"window");
  const windows=()=>d.invoke("get_all_windows",{},"window");
  const history=()=>desktop("capture_history");
  const assertSession=async label=>{
    await d.main();const registered=await d.invoke("registered_libraries");
    d.assert(d.session===session&&await d.invoke("safe_mode")===true&&JSON.stringify(registered.map(item=>item.library.id).sort())===JSON.stringify([...state.providers].sort()),"original stage keeps the same real A/B session and global safe mode: "+label,{session:d.session,registered});
  };
  const originalBefore=fileRecord(original.path);
  d.assert(originalBefore.sha256===original.sha256&&originalBefore.bytes===original.bytes,"this same-session capture oracle uses the original imported fixture bytes",originalBefore);
  await assertSession("before");
  const historyBefore=await history(),pinsBefore=(await windows()).filter(label=>label.startsWith("pin-"));
  d.assert(pinsBefore.length===0,"earlier combination phases leave no pin over the measured original views",pinsBefore);
  const observerManifest=join(d.work,"original-native-binding.json");
  if(existsSync(observerManifest))throw Error("Preserve this round's existing original observer manifest");
  writeFileSync(observerManifest,JSON.stringify({application:plan.application.path,binarySha256:plan.application.sha256,buildSource:plan.build.source,session},null,2));
  const probes=originalProbes({ d, workflow, fixture, original, session, state, save, desktop, native, windows, history, assertSession, observerManifest });
  const { focusMain, readClipboard, closePopup, paintedGeometry, wallOriginal, prepareWall, pinReady }=probes;
  const { beginSelection, capture, rejectedCopy, trashedSourceCopy }=originalCapture({ d, workflow, fixture, original, session, state, save, desktop, native, windows, history, assertSession, observerManifest, ...probes });
  await workflow.current(workflow.a.id);await workflow.scope(workflow.a.id,workflow.folderA);await workflow.clearSearch();await closePopup();
  const first=await capture("wall-copy",prepareWall,"copy");
  d.assert(first.source.thumbnail.width<original.width,"the real wall displays a reduced derivative before original copy",first.source.thumbnail);
  await capture("wall-pin",prepareWall,"pin");
  await d.main();focusMain();
  await d.exec("document.querySelector('input[aria-label=查找参考图]').focus({preventScroll:true});document.querySelector('.wall').scrollTop=0;");
  const top=await until("real virtualization removes the original at the top",()=>d.exec("const wall=document.querySelector('.wall');const ids=[...wall.querySelectorAll('.card')].map(node=>node.dataset.id);return wall.scrollTop<1&&ids.length&&!ids.includes(arguments[0])?{ids,width:wall.clientWidth,total:wall.dataset.total}:null;",[workflow.targetA.contentId]));
  const returned=await capture("wall-virtual-return",wallOriginal,"copy");
  state.virtual={top,returned:returned.source.wall};
  d.assert(returned.source.wall.ids.some(id=>!top.ids.includes(id))&&returned.source.wall.ids.includes(workflow.targetA.contentId),"the same session actually recycles wall nodes then captures the returned original",state.virtual);save();
  const widthBefore=await d.exec("return document.querySelector('.wall').clientWidth;");
  await workflow.readyClick("//button[@aria-label='收起侧栏']");
  const collapsed=await until("actual wall client width changes after sidebar collapse",()=>d.exec("const width=document.querySelector('.wall').clientWidth;return width!==arguments[0]?width:null;",[widthBefore]));
  const reflow=await capture("wall-width-reflow",prepareWall,"copy");
  await workflow.readyClick("//button[@aria-label='展开侧栏']");
  const restored=await until("actual wall width restored",()=>d.exec("const width=document.querySelector('.wall').clientWidth;return width===arguments[0]?width:null;",[widthBefore]));
  state.reflow={widthBefore,collapsed,restored,source:reflow.source};save();
  // 单击只选中并聚焦卡片，Enter 打开查看器（#146）。
  await prepareWall();await workflow.readyClick("//*[@role='option' and @data-id="+literal(workflow.targetA.contentId)+"]");await d.key("\uE007");
  await workflow.readyClick("//*[@aria-label='原图查看器']//*[@role='toolbar' and @aria-label='查看工具']//button["+named("适应窗口")+"]");
  const viewerSource=async()=>{await d.main();return until("actual fitted A viewer original is decoded",()=>paintedGeometry("viewer"));};
  const viewer=await capture("viewer-copy",viewerSource,"copy");
  d.assert(viewer.source.thumbnail.width<original.width,"the real viewer uses its fitted derivative while copy reads original pixels",viewer.source.thumbnail);
  await capture("viewer-pin",viewerSource,"pin");
  await workflow.readyClick("//*[@aria-label='原图查看器']//button[@aria-label='返回图片墙']");
  await until("viewer close returns focus to the same real original card",()=>d.exec("return !document.querySelector('[aria-label=原图查看器]')&&document.activeElement?.dataset.id===arguments[0];",[workflow.targetA.contentId]));

  // B remains a distinct source although its original content is identical to A.
  const mainSize=await native("inner_size"),crop={x:137,y:211,width:900,height:600},beforePin=await windows();
  await desktop("pin_reference",{libraryId:workflow.targetB.libraryId,imageId:workflow.targetB.imageId,crop,shown:{x:Math.floor(mainSize.width/3),y:Math.floor(mainSize.height/4),width:360,height:240}});
  const affineLabel=await until("actual B partial reference pin",async()=>(await windows()).find(label=>label.startsWith("pin-")&&!beforePin.includes(label))),affineId=affineLabel.slice(4);
  let sourcePin=await pinReady(affineId);await d.main();
  await desktop("turn_pin",{pin:affineId,turn:"flipHorizontal"});await desktop("turn_pin",{pin:affineId,turn:"rotateClockwise"});
  await desktop("zoom_pin",{pin:affineId,scale:.45,anchorX:sourcePin.shown.x+sourcePin.shown.width/2,anchorY:sourcePin.shown.y+sourcePin.shown.height/2});
  sourcePin=await pinReady(affineId);
  await d.screenshot("09-b-original-crop-affine-pin.png");
  d.assert(sourcePin.frame.pin.content.libraryId===workflow.b.id&&sourcePin.placement.flipH&&sourcePin.placement.rotation===1&&sourcePin.placement.scale===.45&&sameRect(sourcePin.crop,crop),"the same-session B pin is genuinely cropped, flipped, quarter-turned and zoomed",sourcePin);
  const affineSource=()=>pinReady(affineId);
  await capture("affine-pin-copy",affineSource,"copy");await capture("affine-pin-pin",affineSource,"pin");
  const closed=await beginSelection("closed-pin",affineSource);closed.clipboardBefore=readClipboard("closed-pin-before");save();
  const exactPinHandle=await d.window(affineLabel);
  d.assert(await d.exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label===arguments[0];",[affineLabel]),"closed-source command is sent only from that exact real pin WebView",{affineLabel,exactPinHandle});
  await d.exec("void window.__TAURI_INTERNALS__.invoke('plugin:desktop|close_pin',{pin:arguments[0]});return true;",[affineId]);
  await until("the exact frozen pin handle is destroyed by public close_pin",async()=>!(await d.request("GET",d.session+"/window/handles")).includes(exactPinHandle));
  await d.main();
  d.assert((await d.request("GET",d.session+"/window/handles")).includes(closed.handle),"closing the source pin leaves this exact frozen selection active",{pin:exactPinHandle,capture:closed.handle});
  closed.close={label:affineLabel,handle:exactPinHandle,method:"public-close_pin-from-own-WebView"};
  d.assert(await desktop("pin_frame",{pin:affineId})===null&&!(await windows()).includes(affineLabel),"the exact frozen B reference pin is really destroyed from its own WebView",{affineId,affineLabel});
  state.closedPin=closed;await rejectedCopy(closed);

  const invalid=await beginSelection("deleted-a-source",prepareWall);invalid.clipboardBefore=readClipboard("deleted-a-source-before");save();
  await d.main();await d.invoke("workspace_edit_source",{target:workflow.targetA,safeMode:true,edits:[{kind:"delete"}]});
  const deleted=await d.invoke("image",{libraryId:workflow.a.id,imageId:workflow.targetA.imageId}),bVisible=await workflow.inspect(workflow.targetB);
  d.assert(deleted.deletedAt!==null&&bVisible.detail.deletedAt===null,"only the frozen A source is deleted while byte-identical B stays registered and available",{deleted,bVisible});
  state.invalidSource=invalid;await trashedSourceCopy(invalid);
  await d.invoke("workspace_edit_source",{target:workflow.targetA,safeMode:true,edits:[{kind:"restore"}]});
  d.assert((await workflow.inspect(workflow.targetA)).detail.deletedAt===null,"an explicit same-session action restores the original A source");
  await workflow.scope(workflow.a.id,workflow.folderA);await workflow.clearSearch();await prepareWall();
  const afterHistory=await history(),afterOriginal=fileRecord(original.path),remaining=(await windows()).filter(label=>label.startsWith("pin-"));
  d.assert(JSON.stringify(afterHistory)===JSON.stringify(historyBefore)&&remaining.length===0,"all original-region cases leave ordinary screenshot history unchanged and close their actual pins",{historyBefore,afterHistory,remaining});
  d.assert(afterOriginal.sha256===originalBefore.sha256&&afterOriginal.bytes===originalBefore.bytes,"the continuous original-region workflow preserves the imported fixture original bytes",{before:originalBefore,after:afterOriginal});
  await assertSession("after source restore");
  state.status="verified-same-session-original-regions";state.originalBefore=originalBefore;state.originalAfter=afterOriginal;state.historyBefore=historyBefore;state.historyAfter=afterHistory;save();
}
