// #78 T10: explicit save destinations and real running-task ownership in the formal application.
// Setup uses public Tauri actions; curation uses the rendered explicit-source controls.
// Usage: node e2e/save-destination.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { driverClient, importUi, writeTestPng } from "./save-destination.helpers.mjs";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/save-destination.mjs <owned kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `save-destination-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
const imagePath = join(work, "image.png");
writeTestPng(imagePath);
const port = 4586;
const driverUrl = `http://127.0.0.1:${port}`;
const { wd, delay, until, assertions, assert, Session } = driverClient({ driverUrl, application, work });

const appData = join(work, "app-data");
const scriptSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const scriptSha256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const manifestPath = resolve(process.argv[4] ?? "work/e2e/t10-build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
if (manifest.binarySha256.toLowerCase() !== binarySha256) throw new Error("Binary does not match the build manifest");
const source = manifest.source;
const sourceTree = spawnSync("git", ["rev-parse", source + "^{tree}"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const provenance = { scriptSource, scriptSha256, sourceTree, manifestPath, driverSha256: createHash("sha256").update(readFileSync(resolve(edgeArg))).digest("hex") };
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4587", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: appData, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});

let session, a, b, c, environment;
const receipts=[];
// The UI steps read the live session through this getter (stopApp sets it to null and restarts the app).
const { local, task, finish, dialogX, importDialog, libraryChoice, shown, choose, pick, readyClick, openImport, startOpened, begin, exists, chooseNextTarget, openPane, shownCurrentName, browseAll, runningCard, createLibraryFromMenu } = importUi({ get session() { return session; } }, { until });
// End only this run's own application processes: descendants of this run's tauri-driver PID.
function ownAppPids(){
 const r=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","$all=Get-CimInstance Win32_Process;$set=@([int]$env:KINSHOKO_E2E_DRIVER);do{$n=$set.Count;$set=@($set+($all|Where-Object{$set -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId})|Select-Object -Unique)}while($set.Count -ne $n);$all|Where-Object{$set -contains [int]$_.ProcessId -and $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE}|ForEach-Object{$_.ProcessId}"],{env:{...process.env,KINSHOKO_E2E_DRIVER:String(driver.pid),KINSHOKO_E2E_EXECUTABLE:application},encoding:"utf8",windowsHide:true});
 return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
function quitOwnApp(){for(const pid of ownAppPids())spawnSync("taskkill",["/PID",String(pid),"/F"],{stdio:"ignore",windowsHide:true});}

const running=id=>until("import is still running",async()=>{const t=await task(id);if(t?.report)throw new Error("Fixture completed before running-state operation");return t?.progress.done>0&&t.progress.done<t.progress.total?t:null;});
const stopApp=async()=>{if(session)await session.close().catch(()=>{});session=null;quitOwnApp();await delay(800);};
try{
 await until("driver",()=>fetch(driverUrl+"/status").then(r=>r.ok));
 session=await Session.start();
 environment=await session.exec("return {userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight};");
 a=await session.invoke("create_library",{parent:libraries,name:"浏览库 A"});
 b=await session.invoke("create_library",{parent:libraries,name:"保存库 B"});
 const aFolder=await session.invoke("create_folder",{libraryId:a.id,name:"A 独立目录",parent:null}).catch(async()=>{
   await session.invoke("switch_library",{libraryId:a.id});return session.invoke("create_folder",{libraryId:a.id,name:"A 独立目录",parent:null});
 });
 await session.invoke("switch_library",{libraryId:b.id});
 const bFolder=await session.invoke("create_folder",{libraryId:b.id,name:"B 最终目录",parent:null});
 await session.invoke("switch_library",{libraryId:a.id});
 await session.exec("location.reload();");
 await until("formal current A",()=>shownCurrentName("浏览库 A"));
 await openImport([imagePath]);
 assert(await session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!s&&s.value==='';",[libraryChoice(importDialog)]),"global import begins with an explicit unchosen destination");
 const first=await startOpened(b.id,bFolder);
 const firstReceipt=await finish(first);receipts.push(firstReceipt);
 assert(firstReceipt.destination.libraryId===b.id&&firstReceipt.destination.folderId===bFolder,"ordinary import receipt keeps the submitted library and folder");
 assert((await local(b.id,bFolder)).total===1&&(await local(a.id)).total===0,"ordinary file is committed into B folder while A remains empty");
 assert((await session.invoke("current_library")).id===a.id,"saving into B does not activate B or change browsing current A");
 await session.screenshot("explicit-import-destination.png");
 const long=await begin(Array(2000).fill(imagePath),b.id,bFolder);
 const before=await running(long);receipts.push({phase:"before-current-create-target-change",receipt:before});
 // The actual new-library page must preserve the running task while its current provider changes.
 await createLibraryFromMenu("新浏览库 C",libraries);
 c=await until("created current C",async()=>{const value=await session.invoke("current_library");return value?.name==="新浏览库 C"?value:null;});
 await until("formal current C",()=>shownCurrentName("新浏览库 C"));
 await chooseNextTarget(a.id,aFolder);
 await browseAll();
 const during=await task(long);receipts.push({phase:"after-current-create-target-change",receipt:during});
 assert(during.report===null&&during.destination.libraryId===b.id&&during.destination.folderId===bFolder,"changing current by creating C and selecting save A while running keeps B task ownership");
 assert(await until("visible running card",()=>session.exec("const card=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!card&&card.getClientRects().length>0&&[...card.querySelectorAll('.k-task-sub')].some(n=>n.textContent.includes('放到 保存库 B / B 最终目录'));",[runningCard])),"formal progress visibly reports original B position after selecting A");
 assert(!await session.exec("return [...document.querySelectorAll('.k-task')].some(card=>card.textContent.includes('已导入，正在把标签定义存进图库'));"),"running task does not claim content completion before its actual report");
 assert(await session.invoke("cancel_import",{libraryId:a.id,taskId:long}).then(()=>false,()=>true),"wrong-owner cancellation is rejected during the real task");
 await session.screenshot("running-owner-after-current-and-target-change.png");
 const completed=await finish(long);receipts.push(completed);
 assert(!completed.report.cancelled&&completed.report.items.length===2000,"B task completes all 2000 entries after current/create/target changes");
 assert((await local(a.id)).total===0&&(await local(c.id)).total===0&&(await local(b.id,bFolder)).total===1,"completed content stays in B rather than new current or newly selected A");
 // Remove a real target folder while the selected task is visibly running.
 await session.invoke("switch_library",{libraryId:b.id});
 const vanished=await session.invoke("create_folder",{libraryId:b.id,name:"运行中失效目录",parent:null});
 await session.invoke("switch_library",{libraryId:c.id});
 const failing=await begin(Array(1200).fill(imagePath),b.id,vanished);
 const deletionPhase=await running(failing);
 const deletion=spawnSync("python",["-c","import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1],timeout=10); c.execute('DELETE FROM folder_member WHERE folder_id=?',(sys.argv[2],)); c.execute('DELETE FROM folder_decision WHERE folder_id=?',(sys.argv[2],)); c.execute('DELETE FROM folder WHERE id=?',(sys.argv[2],)); c.commit(); print(json.dumps({'externalFolderRemoved':sys.argv[2]}))",join(b.root,"library.sqlite"),vanished],{windowsHide:true,encoding:"utf8"});
 if(deletion.status!==0)throw new Error(deletion.stderr);
 await chooseNextTarget(a.id,aFolder);
 const failed=await finish(failing);receipts.push({phase:"external-folder-loss-while-running",before:deletionPhase,operation:JSON.parse(deletion.stdout),after:failed});
 const successful=failed.report.items.filter(item=>["imported","merged","refreshed","newVersion"].includes(item.outcome.kind));
 const rejected=failed.report.items.filter(item=>item.outcome.kind==="readFailed");
 assert(successful.length>0&&rejected.length>0&&failed.report.items.length===1200,"running target loss reports completed and failed items instead of a whole-batch success");
 assert(rejected.every(item=>/保存目标不可用|没有这个文件夹/.test(item.outcome.reason)),"remaining failures name the actual unavailable destination");
 assert((await local(a.id)).total===0&&(await local(c.id)).total===0,"failed target does not fall back into the newly chosen or current library");
 await session.screenshot("actual-partial-import-result.png");
 // Explicit UI cancellation follows its original owner after the next target changes.
 const cancelledTask=await begin(Array(1200).fill(imagePath),b.id,bFolder);
 const cancelBefore=await running(cancelledTask);await chooseNextTarget(a.id,aFolder);
 await readyClick(`${runningCard}//button[@aria-label='取消导入']`);
 const cancelled=await finish(cancelledTask);receipts.push({phase:"owner-cancel-after-target-change",before:cancelBefore,after:cancelled});
 assert(cancelled.report.cancelled&&cancelled.destination.libraryId===b.id,"formal cancel applies to original B even when the next target is A");
 assert((await local(a.id)).total===0,"cancelled B work never writes into the next A target");
 // Eagle uses the same destination and retains its provider folders.
 const eagleRoot=join(work,"eagle.library");mkdirSync(join(eagleRoot,"images","ITEM1.info"),{recursive:true});
 writeFileSync(join(eagleRoot,"images","ITEM1.info","eagle.png"),readFileSync(imagePath));
 writeFileSync(join(eagleRoot,"images","ITEM1.info","metadata.json"),JSON.stringify({id:"ITEM1",name:"eagle",ext:"png",width,height,size:readFileSync(imagePath).length,tags:["T10 Eagle"],folders:["SOURCE"],annotation:"原 Eagle 来源",url:"https://example.com/t10",isDeleted:false,btime:1,mtime:2,modificationTime:3}));
 writeFileSync(join(eagleRoot,"metadata.json"),JSON.stringify({applicationVersion:"4.0.0",folders:[{id:"SOURCE",name:"Eagle 原目录",children:[]}]}));
 const eagleTask=await begin([eagleRoot],b.id,bFolder,true);const eagleReceipt=await finish(eagleTask);receipts.push(eagleReceipt);
 assert(eagleReceipt.report.fromEagle&&eagleReceipt.report.items[0].outcome.kind!=="readFailed"&&eagleReceipt.destination.folderId===bFolder,"real Eagle entry uses the chosen final folder");
 // A finished Eagle import opens its 标签的外部对应 step over the window; close it as the combined Eagle stage does.
 await until("Eagle tag step",()=>exists("//*[@aria-label='标签的外部对应']"));await readyClick("//*[@aria-label='标签的外部对应']/header/button");
 await until("Eagle tag step closed",async()=>!await exists("//*[@aria-label='标签的外部对应']"));
 const bCard=(await local(b.id,bFolder)).cards[0];
 const target={libraryId:b.id,imageId:bCard.imageId,contentId:bCard.id};
 const sourceGroup=await session.invoke("workspace_source_group",{target,safeMode:true,name:"T10 原来源包",groupId:null});
 const packagePath=join(work,"source.kinshoko-group");
 await session.desktop("export_reference_group_package",{groupId:sourceGroup.id,path:packagePath});
 await openPane("参考组");
 await readyClick("//button[normalize-space()='导入参考组包']");
 const packageDialog=dialogX("导入参考组包");
 await choose(a.id,aFolder,packageDialog);await pick(packagePath);
 await readyClick(`${packageDialog}//button[normalize-space()='选择参考组包并导入']`);
 await until("package saved to A",async()=>(await local(a.id,aFolder)).total===1);
 assert((await session.invoke("current_library")).id===c.id,"formal package import into A keeps current C");
 await session.screenshot("package-explicit-destination.png");
 // The real clipboard entry creates capture history. Collection then uses the shared dialog.
 const copied=spawnSync("powershell",["-NoProfile","-NonInteractive","-STA","-Command","Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $t10Image=[System.Drawing.Image]::FromFile($env:KINSHOKO_T10_CLIPBOARD); [System.Windows.Forms.Clipboard]::SetImage($t10Image); $t10Image.Dispose()"],{env:{...process.env,KINSHOKO_T10_CLIPBOARD:imagePath},windowsHide:true,encoding:"utf8"});
 if(copied.status!==0)throw new Error(copied.stderr);
 await session.desktop("pin_clipboard");
 // Move the genuine always-on-top capture pin away from the controls under test.
 const nativeWindows=await wd("POST",`${session.base}/execute/async`,{script:"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows').then(done);",args:[]});
 for(const label of nativeWindows)if(label.startsWith("pin-"))await session.desktop("move_pin",{pin:label.slice(4),x:1400,y:800});
 const capture=(await session.desktop("capture_history"))[0];
 await openPane("截图历史");
 await readyClick("//*[contains(@class,'capture-history')]//button[normalize-space()='收藏']");
 // The 收藏截图 save-target dialog: one dialog, two choices (图库, 文件夹).
 const collectDialog=dialogX("收藏截图");
 await choose(b.id,bFolder,collectDialog);await session.screenshot("capture-save-target-dialog.png");
 await readyClick(`${collectDialog}//button[normalize-space()='收藏']`);
 await until("collect dialog closed",async()=>!await exists(collectDialog));
 const collected=await until("actual collected capture",async()=>{const entry=(await session.desktop("capture_history")).find(e=>e.id===capture.id);return entry?.collected.find(c=>c.libraryId===b.id);});
 const captureSha=createHash("sha256").update(readFileSync(join(appData,"captures",capture.id+".png"))).digest("hex");
 assert((await local(b.id,bFolder)).cards.some(card=>card.id===captureSha&&card.imageId===collected.imageId),"screenshot collection preserves the capture bytes in the chosen B folder");
 await session.screenshot("capture-explicit-destination.png");
 // Existing independent target curation survives explicit source copying.
 const cImport=await session.invoke("start_import",{libraryId:c.id,source:{paths:[imagePath]},destination:{libraryId:c.id,folderId:null}});await finish(cImport);
 const cCard=(await local(c.id)).cards.find(card=>card.id===bCard.id);
 const cTarget={libraryId:c.id,imageId:cCard.imageId,contentId:cCard.id};
 await session.invoke("workspace_edit_source",{target:cTarget,safeMode:true,edits:[{kind:"setNote",text:"C 独立人工备注"}]});
 await browseAll();
 // The card's source button is a sibling of its option; with N sources it reads “在 N 个图库 · 查看详情”.
 const sourcesButton=`//div[@role='listbox' and @aria-label='图片墙']//button[contains(@class,'card-sources') and @data-card='${bCard.id}' and starts-with(@aria-label,'在 ')]`;
 await until("aggregate source choices",()=>shown(sourcesButton));
 await readyClick(sourcesButton);
 await readyClick(`//*[@data-source-library-id='${b.id}']//button[normalize-space()='整理此来源']`);
 await readyClick("//button[normalize-space()='复制到…']");
 const copyDialog=dialogX("复制此来源");
 await choose(c.id,null,copyDialog);await session.screenshot("copy-explicit-confirmation.png");await readyClick(`${copyDialog}//button[normalize-space()='确认复制']`);
 await until("source copy finished",async()=>!await exists(copyDialog));
 const cAfter=await until("copy source facts saved",async()=>{const value=await session.invoke("workspace_source_inspection",{target:cTarget,safeMode:true,lang:"zh-CN"});return value.detail.note.sources.some(s=>s.source.includes(b.id))?value:null;});
 assert(cAfter.detail.note.sources.some(s=>s.source.includes(b.id)),"cross-library copy retains the original B provenance");
 assert(cAfter.detail.note.manual==="C 独立人工备注","formal cross-library copy preserves the existing target manual note");
 assert((await local(c.id)).total===1,"copy merges identical bytes without creating a public pool or a duplicate target image");
 await until("copy confirmation stays closed after refresh",async()=>!await exists(copyDialog));
 await delay(500);
 assert(!await exists(copyDialog),"copy confirmation stays closed after the real source refresh");
 await session.screenshot("copy-preserves-independent-curation.png");
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,finishedAt:new Date().toISOString()},null,2));
 console.log(`Evidence: ${work}`);
}catch(error){
 console.error(error);if(session){await session.screenshot("failure.png").catch(()=>{});await session.exec("return document.documentElement.outerHTML;").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,error:String(error)},null,2));process.exitCode=1;
}finally{
 await stopApp();if(driver.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
}
