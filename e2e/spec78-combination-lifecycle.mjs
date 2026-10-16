// Separate process lifecycles after the continuous combined session.
// All moves name previously generated fixture directories and verify the owned absolute targets.
import { mkdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { CombinationDriver, until } from "./spec78-combination-driver.mjs";
import { CombinationWorkflow } from "./spec78-combination-workflow.mjs";
import { programChoices, restoreContent, replaceSettings } from "./spec78-combination-backup.mjs";
import { clearKnownFolderForBlank, ownedWork } from "./spec78-combination-preflight.mjs";

export async function restartAndOffline(workflow) {
  const d=workflow.d;await d.normalQuit("continuous-session-complete");await d.boot();
  workflow.phase("separate-normal-restart");
  const settings=await d.invoke("shell_settings",{},null);
  d.assert(settings.forceSrgb&&settings.forceSrgbInEffect&&settings.viewerBackground==="checker","normal tray Quit and real restart activate saved sRGB and retain the viewer background",settings);
  d.assert(JSON.stringify(await programChoices(workflow))===JSON.stringify(workflow.savedChoices),"normal restart preserves names, removed aliases, shared groups and personal rules");
  await d.screenshot("11-normal-restart.png");
  // Inspect only metadata from this round's generated/restored owned providers.
  // Manual Explicit and absent manual/automatic rows are direct fixture premises;
  // this harness does not reproduce the product's effective-rating rules.
  d.assert(await d.invoke("safe_mode")===true,"offline inventory keeps global safe mode continuously on");
  const registered=await d.invoke("registered_libraries"),owned=[{library:workflow.a,oldId:workflow.a.id},{library:workflow.b,oldId:workflow.b.id},...workflow.restored.libraries];
  const inputs=registered.map(entry=>{
    const source=owned.find(source=>source.library.id===entry.library.id);if(!source)throw Error("Unexpected provider in the isolated inventory");
    return {library:entry.library,oldId:source.oldId};
  });
  const script="import sqlite3,json,sys,pathlib\nresult=[]\nfor entry in json.loads(sys.argv[1]):\n p=pathlib.Path(entry['library']['root'])/'library.sqlite'; db=sqlite3.connect(p.resolve().as_uri()+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON')\n image=db.execute('SELECT id,sha256,size,rating_manual FROM image WHERE sha256=?',(sys.argv[2],)).fetchone()\n if image is None: raise RuntimeError('Owned sealed metadata missing')\n facts=db.execute('SELECT source,rating,score FROM rating_fact WHERE image_id=? ORDER BY source',(image[0],)).fetchall();db.close()\n result.append({**entry,'imageId':image[0],'sha256':image[1],'bytes':image[2],'manual':image[3],'automatic':[{'source':row[0],'rating':row[1],'score':row[2]} for row in facts]})\nprint(json.dumps(result))";
  const read=spawnSync("python",["-c",script,JSON.stringify(inputs),workflow.fixture.inputs.sealed.sha256],{windowsHide:true,encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
  if(read.status!==0)throw Error("Owned read-only rating metadata failed: "+read.stderr);
  const known=JSON.parse(read.stdout),adult=known.filter(source=>source.oldId===workflow.b.id),unknown=known.filter(source=>source.oldId===workflow.a.id);
  d.assert(adult.length>=2&&adult.every(source=>source.manual==="explicit"&&source.sha256===workflow.fixture.inputs.sealed.sha256)&&adult.some(source=>source.library.id===workflow.b.id),"same-round public registrations and actual manual metadata account for original/restored Adult B",{registered,adult});
  d.assert(unknown.length>=2&&unknown.every(source=>source.manual===null&&source.automatic.length===0&&source.sha256===workflow.fixture.inputs.sealed.sha256),"actual original/restored A metadata remains genuinely Unknown",unknown);
  for(const source of adult)if(source.library.id!==workflow.b.id)await d.invoke("unregister_library",{libraryId:source.library.id});
  await workflow.current(workflow.a.id);
  d.assert(await d.invoke("safe_mode")===true&&!(await workflow.local(workflow.a.id)).cards.some(card=>card.id===workflow.sealedA.contentId),"the last registered Adult B still vetoes Unknown A before disconnection");
  const requested=resolve(workflow.b.root),offline=resolve(workflow.b.root+".offline");
  ownedWork(dirname(requested));ownedWork(dirname(offline));
  if(dirname(requested)!==dirname(offline)||requested===offline)throw Error("Unexpected offline directory move");
  await d.normalQuit("before-owned-provider-disconnection");
  renameSync(requested,offline);let returned=false;
  try {
    await d.boot();workflow.phase("separate-offline-provider-restart");
    const registration=await until("public inventory reports the actual disconnected B",async()=>(await d.invoke("workspace_status",{safeMode:true})).libraries.find(entry=>entry.library.id===workflow.b.id&&entry.unavailable));
    await until("rendered unavailable provider reason",()=>d.exec("return !!document.querySelector('[data-library-id=\"'+arguments[0]+'\"] .provider-problem')?.textContent.trim();",[workflow.b.id]));
    d.assert(!(await workflow.local(workflow.a.id)).cards.some(card=>card.id===workflow.sealedA.contentId),"offline B's known Adult fact conservatively vetoes available Unknown A",registration);
    d.assert((await workflow.local(workflow.a.id)).cards.some(card=>card.id===workflow.visibleCard.id),"other provider content remains usable while B is disconnected");
    const note=(await workflow.inspect(workflow.targetA)).detail.note.manual;
    d.assert(await d.invoke("workspace_edit_source",{target:workflow.targetB,safeMode:true,edits:[{kind:"setNote",text:"不得回退写入甲来源"}]}).then(()=>false,()=>true),"an unavailable explicit B source cannot fall back to available A bytes");
    d.assert((await workflow.inspect(workflow.targetA)).detail.note.manual===note,"failed unavailable-source editing leaves A curation intact");
    const group=await d.invoke("reference_group",{groupId:workflow.referenceB.id},"desktop");
    d.assert(group.group.members[0].libraryId===workflow.b.id&&group.members[0].state.kind==="unavailable","offline source group keeps B identity and exposes its actual unavailable state",group);
    await d.screenshot("12-offline-provider-with-conservative-veto.png");
    await d.normalQuit("after-owned-provider-disconnection");renameSync(offline,requested);returned=true;
  } finally {
    if(!returned) { await d.cleanup();renameSync(offline,requested); }
  }
  await d.boot();await until("the restored path is available again",async()=>(await d.invoke("workspace_status",{safeMode:true})).libraries.find(entry=>entry.library.id===workflow.b.id&&entry.unavailable===null));
  await d.invoke("unregister_library",{libraryId:workflow.b.id});
  const now=await until("removing the verified last Adult registration releases the veto",async()=>{const page=await workflow.local(workflow.a.id);return page.cards.find(card=>card.id===workflow.sealedA.contentId);});
  d.assert(now&&!now.adult,"unregistering the actual last known Adult provider makes remaining Unknown bytes visible",{knownAdult:adult,remaining:await d.invoke("registered_libraries"),now});
  workflow.state.lifecycle={settings,knownSources:known,removedRestoredAdult:adult.filter(source=>source.library.id!==workflow.b.id),offlineMove:{requested,offline},lastAdultRemoved:workflow.b.id};workflow.save();
  await d.normalQuit("before-separate-blank-environment");
}
export async function blankEnvironment(workflow,plan) {
  const previous=workflow.d,work=join(previous.work,"blank-environment");mkdirSync(work,{recursive:true});
  const knownFolder=clearKnownFolderForBlank(work);
  const d=new CombinationDriver({application:plan.application.path,edgeDriver:plan.edgeDriver.path,tauriDriver:plan.tauriDriver.path,work,port:plan.port,data:join(work,"app-data"),profile:join(work,"webview")});
  const blank=new CombinationWorkflow(d,workflow.fixture);
  Object.assign(blank,{blue:workflow.blue,aqua:workflow.aqua,parted:workflow.parted,removedAlias:workflow.removedAlias});
  try {
    await d.boot();blank.phase("separate-blank-content-then-program-restore");
    d.assert((await d.invoke("registered_libraries")).length===0,"a genuinely blank app-data/profile and KnownFolder start with no old device registrations",knownFolder);
    const restored=await restoreContent(blank,workflow.backup,join(work,"content-restored"),"13-blank-content");
    const choices=await programChoices(blank);
    d.assert(choices.preferences.length===0&&choices.groups.length===0&&choices.rules.length===0,"blank content restoration interprets definitions without importing program preferences, groups or rules",choices);
    const registration=await d.invoke("registered_libraries");
    d.assert(registration.length===workflow.backup.preview.scope.libraries.length&&registration.every(entry=>restored.libraries.some(restored=>restored.library.id===entry.library.id)),"blank content restore registers only its newly restored providers",registration);
    await replaceSettings(blank,workflow.settingsFile,"14-blank-program");
    d.assert(JSON.stringify(await programChoices(blank))===JSON.stringify(workflow.savedChoices),"separate program restore supplies the saved names, global groups, personal rules and deletion memory");
    d.assert(JSON.stringify(await d.invoke("registered_libraries"))===JSON.stringify(registration),"program settings do not recreate old device registrations in the blank environment");
    const a=restored.libraries.find(entry=>entry.oldId===workflow.a.id).library;
    await blank.closeSettings();await blank.current(a.id);await blank.scope();
    await blank.searchTag("最贴切的蓝瞳");
    await until("restored definitions and preferences drive a real blank-environment search",()=>d.exec("return Number(document.querySelector('.wall')?.dataset.total)>0;"));
    await d.screenshot("15-blank-restored-real-search.png");
    await d.normalQuit("blank-environment-complete");
    const result={status:"verified-native-lifecycle",knownFolder,restored,choicesAfterContent:choices,registration,assertions:d.assertions};d.save("result.json",result);return result;
  } catch(error) {
    d.save("failure.json",{status:"failed",error:String(error),phase:blank.state.phase,assertions:d.assertions});
    if(d.session){await d.screenshot("failure.png").catch(()=>{});await d.exec("return document.documentElement.outerHTML;").then(html=>d.save("failure-dom.json",html)).catch(()=>{});}throw error;
  } finally {try{await d.cleanup();}finally{previous.rememberOwned({processes:d.ownedProcesses});}}
}
