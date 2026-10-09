// Both backup boundaries inside the same T20 session. No app starts at import.
// SQLite is opened read-only solely to match a restored provider to its public new ID.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "./spec78-combination-fixture.mjs";
import { until } from "./spec78-combination-driver.mjs";

const section="//section[@aria-label='资料库备份']";
export function originalHashes(root) {
  const files={};
  function walk(path) { for(const name of readdirSync(path).sort()) { const child=join(path,name);if(statSync(child).isDirectory())walk(child);else files[relative(root,child).replaceAll("\\","/")]=sha256(readFileSync(child)); } }
  walk(join(root,"originals"));return files;
}
export const imageFacts=value=>JSON.stringify(value,(key,item)=>["name","label","sourceName"].includes(key)?undefined:item);
const programGroups=value=>value.map(group=>({id:group.id,name:group.name,namespace:group.namespace,tags:group.tags.map(member=>member.tag.id)}));
const programRules=value=>value.entries.map(entry=>({a:entry.a.id,b:entry.b.id,relation:entry.relation})).sort((a,b)=>(a.a+a.b).localeCompare(b.a+b.b));
export async function programChoices(workflow) {
  const d=workflow.d,catalog=await workflow.catalog();
  return {
    preferences:catalog.tags.filter(tag=>tag.namePreferences.length).map(tag=>({id:tag.id,names:tag.namePreferences})).sort((a,b)=>a.id.localeCompare(b.id)),
    groups:programGroups(await d.invoke("shared_tag_groups",{lang:"zh-CN",safeMode:true})),
    rules:programRules(await d.invoke("shared_personal_approx",{lang:"zh-CN",safeMode:true})),
    removedAliasPresent:catalog.tags.find(tag=>tag.id===workflow.blue)?.aliases.some(alias=>alias.name===workflow.removedAlias.name)??false,
  };
}
export async function providerFacts(workflow,library,target) {
  const d=workflow.d;
  const inspection=await workflow.inspect(target);
  return {detail:inspection.detail,tags:inspection.tags,sidebar:await d.invoke("workspace_sidebar",{libraryId:library.id,safeMode:true}),originals:originalHashes(library.root)};
}
export async function exportSettings(workflow,path) {
  const d=workflow.d;await workflow.settings();await d.set("//input[@aria-label='程序设置备份文件']",path);
  await workflow.readyClick("//button[normalize-space()='备份当前程序设置']");
  await until("actual program settings file saved",()=>d.exec("return document.querySelector('fieldset[aria-label=程序设置备份]')?.textContent.includes('程序设置备份完成。');"));
  return JSON.parse(readFileSync(path,"utf8"));
}
export async function replaceSettings(workflow,path,label) {
  const d=workflow.d;await workflow.settings();await d.set("//input[@aria-label='程序设置备份文件']",path);
  d.assert(!await d.exec("return !!document.querySelector('[role=group][aria-label=确认替换程序设置]');"),"replacement first requires reading the selected package: "+label);
  await workflow.readyClick("//button[normalize-space()='读取程序设置备份']");
  await until("actual replacement scope shown",()=>d.exec("return document.querySelector('[role=group][aria-label=确认替换程序设置]')?.textContent.includes('缺席的名称偏好和个人规则会删除');"));
  await d.screenshot(label+"-program-settings-scope.png");
  await workflow.readyClick("//button[normalize-space()='替换程序设置']");
  await until("program settings replacement really completes",()=>d.exec("return document.querySelector('fieldset[aria-label=程序设置备份]')?.textContent.includes('程序设置恢复完成。');"));
  d.assert(!await d.exec("return !!document.querySelector('fieldset[aria-label=程序设置备份] [role=alert]');"),"replacement reports no runtime registration errors: "+label);
}
export async function chooseBackup(workflow,path) {
  const d=workflow.d;mkdirSync(path,{recursive:true});await workflow.settings();
  await d.pick(path);await workflow.readyClick(`${section}//button[normalize-space()='选择备份目录…']`);
  await until("content backup destination is actually saved",async()=>(await d.invoke("backup_status",{},null)).plan.target===path);
}
function provenance(libraries) {
  const script="import sqlite3,json,sys,pathlib\nresult=[]\nfor library in json.loads(sys.argv[1]):\n db=sqlite3.connect((pathlib.Path(library['root'])/'library.sqlite').resolve().as_uri()+'?mode=ro',uri=True); db.execute('PRAGMA query_only=ON')\n rows=db.execute('SELECT old_library_id,backup_id,restored_at FROM restore_provenance ORDER BY restored_at,rowid').fetchall(); db.close()\n result.append({'library':library,'provenance':[{'oldLibraryId':row[0],'backupId':row[1],'restoredAt':row[2]} for row in rows]})\nprint(json.dumps(result))";
  const result=spawnSync("python",["-c",script,JSON.stringify(libraries)],{windowsHide:true,encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
  if(result.status!==0)throw Error("Read-only restored provider provenance failed: "+result.stderr);
  return JSON.parse(result.stdout);
}
export async function restoreContent(workflow,backup,into,label) {
  const d=workflow.d;mkdirSync(into,{recursive:true});await chooseBackup(workflow,backup.directory);
  const beforeLibraries=new Set((await d.invoke("registered_libraries")).map(entry=>entry.library.id));
  const beforeGroups=new Set((await d.invoke("reference_groups",{},"desktop")).map(group=>group.id));
  await workflow.readyClick(`${section}//button[normalize-space()='从备份恢复…']`);
  await d.pick(into);
  // There is exactly one snapshot in this new target. The public status binds its ID.
  const snapshots=await d.invoke("backup_snapshots",{},null);
  d.assert(snapshots.length===1&&snapshots[0].id===backup.report.snapshotId,"rendered restore selects the one newly created content snapshot: "+label,snapshots);
  await workflow.readyClick(`${section}//button[starts-with(@aria-label,'恢复 ')]`);
  const completed=await until("rendered roundtrip plus actual new providers and groups: "+label,async()=>{
    const libraries=(await d.invoke("registered_libraries")).filter(entry=>!beforeLibraries.has(entry.library.id)).map(entry=>entry.library);
    const groups=(await d.invoke("reference_groups",{},"desktop")).filter(group=>!beforeGroups.has(group.id));
    const rendered=await d.exec("const result=document.querySelector('[aria-label=往返检查]');return result?.textContent.includes('往返检查通过')&&[...document.querySelectorAll('.backup-snapshots button')].every(button=>!button.matches(':disabled'))?result.textContent:null;");
    return libraries.length===backup.preview.scope.libraries.length&&groups.length===backup.preview.scope.groups.length&&rendered?{libraries,groups,rendered}:null;
  },90000);
  const libraries=provenance(completed.libraries).map(entry=>{
    const from=entry.provenance.at(-1);
    d.assert(from?.backupId===backup.report.snapshotId&&backup.preview.scope.libraries.some(source=>source.id===from.oldLibraryId),"new public provider has provenance for this actual selected snapshot: "+label,entry);
    d.assert(entry.library.id!==from.oldLibraryId,"content restoration creates an independent provider identity: "+label,entry.library);
    d.assert(JSON.stringify(originalHashes(entry.library.root))===JSON.stringify(backup.originals[from.oldLibraryId]),"restored provider retains every original byte: "+label,{provider:entry.library.id,old:from.oldLibraryId});
    return {...entry,oldId:from.oldLibraryId};
  });
  const groups=[];
  for(const summary of completed.groups) {
    const group=(await d.invoke("reference_group",{groupId:summary.id},"desktop")).group;
    const original=backup.groups.find(value=>value.id===group.restoredFrom?.groupId);
    d.assert(original&&group.restoredFrom.backupId===backup.report.snapshotId&&group.id!==original.id,"restored group retains actual backup and original group provenance: "+label,group);
    const matches=group.members.length===original.members.length&&group.members.every((member,index)=>{
      const source=original.members[index],restored=libraries.find(entry=>entry.oldId===source.libraryId);
      return restored&&member.libraryId===restored.library.id&&member.imageId===source.imageId&&member.sourceWidth===source.sourceWidth&&member.sourceHeight===source.sourceHeight&&JSON.stringify(member.crop)===JSON.stringify(source.crop)&&JSON.stringify(member.placement)===JSON.stringify(source.placement);
    });
    d.assert(matches,"restored group remaps provider IDs and preserves original, crop and layout: "+label,{original,restored:group});groups.push(group);
  }
  await d.exec("document.querySelector('[aria-label=往返检查]')?.scrollIntoView({block:'center'});");
  await d.screenshot(label+"-content-roundtrip.png");
  const result={...completed,libraries,groups};d.save(label+"-content-restore.json",result);return result;
}
export async function combinedBackups(workflow) {
  const d=workflow.d;workflow.phase("same-session-two-distinct-backup-boundaries");
  // These public shell choices only affect the isolated test process. OS autostart stays skipped.
  for(const [command,args]of[["set_autostart",{on:false}],["set_show_approx_source",{on:true}],["set_usage_log",{on:true}],["set_force_srgb",{on:true}],["set_viewer_background",{background:"checker"}],["rebind_shortcut",{action:"capture",accelerator:"Ctrl+Alt+F9"}]])await d.invoke(command,args,null);
  const settingsFile=join(d.work,"本轮程序设置.kinshoko-settings"),settingsPackage=await exportSettings(workflow,settingsFile);
  const savedChoices=await programChoices(workflow);
  d.assert(savedChoices.preferences.some(item=>item.id===workflow.blue)&&savedChoices.rules.length>0&&savedChoices.groups.some(group=>group.id===workflow.sharedGroup),"the actual program package protects the configured names, shared group and personal rule");
  d.assert(!JSON.stringify(settingsPackage).includes(workflow.a.root)&&!JSON.stringify(settingsPackage).includes(workflow.b.root),"portable program settings contain no original device provider roots");
  const directory=join(d.work,"content-backup");await chooseBackup(workflow,directory);
  const preview=await d.invoke("backup_preview",{selection:{kind:"all"}},null);
  const originals=Object.fromEntries([workflow.a,workflow.b].map(library=>[library.id,originalHashes(library.root)]));
  const groups=[];for(const summary of await d.invoke("reference_groups",{},"desktop"))groups.push((await d.invoke("reference_group",{groupId:summary.id},"desktop")).group);
  const expectedCount=Object.values(originals).reduce((count,files)=>count+Object.keys(files).length,0);
  d.assert(preview.scope.libraries.length===2&&preview.scope.libraries.every(item=>[workflow.a.id,workflow.b.id].includes(item.id))&&preview.scope.groups.length===groups.length&&preview.estimate.originals===expectedCount&&preview.scope.uncovered.length===0,"actual content preview covers both current providers, their groups and every original",{preview,expectedCount});
  d.assert(await d.exec("return document.querySelector('[aria-label=资料库备份]')?.textContent.includes('恢复资料库保留当前程序设置');"),"formal content backup states its settings preservation boundary");
  await workflow.readyClick(`${section}//button[normalize-space()='马上备份']`);
  const report=await until("actual content backup completes",async()=>{const status=await d.invoke("backup_status",{},null);return !status.running&&status.lastReport?.complete?status.lastReport:null;},90000);
  const uniqueOriginals=new Set(Object.values(originals).flatMap(files=>Object.values(files))).size;
  d.assert(report.problems.length===0&&report.skipped.length===0&&report.copied===uniqueOriginals&&report.copied+report.reused===expectedCount,"content backup completes without skips and stores byte-identical originals once",{report,uniqueOriginals});
  const backup={directory,preview,report,originals,groups};d.save("content-backup-baseline.json",backup);
  await until("rendered content backup success with scope and settings boundary",()=>d.exec("const s=document.querySelector('section[aria-label=资料库备份]');if(!s||!s.textContent.includes('上次备份：')||s.textContent.includes('正在备份'))return null;s.scrollIntoView({block:'start'});return true;"));
  await d.screenshot("07c-content-backup-complete.png");
  await workflow.closeSettings();
  // Image curation after the backup must survive the later program-settings replacement.
  await d.invoke("workspace_edit_source",{target:workflow.targetB,safeMode:true,edits:[{kind:"setNote",text:"内容备份之后写入的乙来源备注"},{kind:"setRating",rating:"sensitive"}]});
  await d.invoke("workspace_edit_source_tags",{target:workflow.targetB,safeMode:true,edits:[{kind:"add",tag:{kind:"named",namespace:"general",name:"设置替换必须保留的逐图标签",lang:"zh-CN"}}]});
  await workflow.prefer(workflow.blue,"内容恢复期间必须保留的当前程序名称");
  const catalog=await workflow.catalog(),extraId=workflow.mapped(catalog,workflow.a.id,workflow.fixture.a.tags.provider_a_meaning);
  await workflow.prefer(extraId,"程序包中缺席的偏好应删除");
  await d.invoke("create_shared_tag_group",{name:"程序包中缺席的分组应删除",namespace:null});
  await d.invoke("edit_shared_approx",{edit:{kind:"set",rules:[{a:workflow.blue,b:workflow.aqua,relation:"notSimilar"},{a:workflow.blue,b:workflow.parted,relation:"similar"}]},safeMode:true});
  const choicesBeforeContentRestore=await programChoices(workflow);
  const restored=await restoreContent(workflow,backup,join(d.work,"existing-environment-restored"),"08-existing-settings");
  d.assert(JSON.stringify(await programChoices(workflow))===JSON.stringify(choicesBeforeContentRestore),"content restoration preserves current program preferences, alias deletion, global groups and personal rules");
  const restoredB=restored.libraries.find(entry=>entry.oldId===workflow.b.id).library;
  d.assert((await d.invoke("image",{libraryId:restoredB.id,imageId:workflow.targetB.imageId})).note.manual==="乙来源经界面修改的备注","restored B curation comes from the content snapshot while live B retains its later note");
  d.assert((await workflow.inspect(workflow.targetB)).detail.note.manual==="内容备份之后写入的乙来源备注","content restoration does not overwrite the live original provider");
  const beforeRegistration=await d.invoke("registered_libraries");
  const providerBefore=[await providerFacts(workflow,workflow.a,workflow.targetA),await providerFacts(workflow,workflow.b,workflow.targetB)];
  await replaceSettings(workflow,settingsFile,"09-default-replace");
  const settings=await d.invoke("shell_settings",{},null);
  d.assert(settings.forceSrgb&&!settings.forceSrgbInEffect&&settings.viewerBackground==="checker"&&settings.showApproxSource&&settings.usageLog&&!settings.autostart,"restored shell choices apply now and force sRGB remains explicitly pending restart",settings);
  d.assert(await d.invoke("safe_mode")===true,"program replacement keeps the saved global safe mode");
  d.assert(JSON.stringify(await programChoices(workflow))===JSON.stringify(savedChoices),"default program replacement removes absent preferences, groups and rules instead of merging later choices");
  d.assert(JSON.stringify(await d.invoke("registered_libraries"))===JSON.stringify(beforeRegistration),"program replacement preserves this device's current original and restored provider registrations");
  await d.exec("document.querySelector('fieldset[aria-label=程序设置备份]').scrollIntoView({block:'center'});");
  await d.screenshot("09b-program-settings-restored-feedback.png");
  await workflow.closeSettings();
  const providerAfter=[await providerFacts(workflow,workflow.a,workflow.targetA),await providerFacts(workflow,workflow.b,workflow.targetB)];
  d.assert(imageFacts(providerBefore)===imageFacts(providerAfter),"program replacement preserves per-image notes, tags, ratings, folders and original bytes");
  await d.screenshot("10-restored-program-and-independent-image-curation.png");
  workflow.backup=backup;workflow.settingsFile=settingsFile;workflow.savedChoices=savedChoices;workflow.restored=restored;
  workflow.state.backups={settingsFile,settingsSha256:sha256(readFileSync(settingsFile)),savedChoices,backup,restored,beforeRegistration,providerBefore,providerAfter,settings};workflow.save();
}
