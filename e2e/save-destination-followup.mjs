// #78 T10 native follow-up: visible running owner and copy confirmation after source refresh.
// Setup uses public Tauri actions; curation uses the rendered explicit-source controls.
// Usage: node e2e/save-destination-followup.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { driverClient, importUi, writeTestPng } from "./save-destination.helpers.mjs";
import { copyStandaloneRuntime } from "./native-standalone-guard.mjs";

const [, , appArg, edgeArg, manifestArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/save-destination-followup.mjs <owned kinshoko.exe> <msedgedriver.exe>");
const work = process.env.KINSHOKO_STANDALONE_WORK ? resolve(process.env.KINSHOKO_STANDALONE_WORK) : resolve("work", "e2e", `save-destination-followup-${Date.now()}`);
mkdirSync(work, { recursive: true });
const application = copyStandaloneRuntime(appArg, work, "kinshoko-save-destination-followup.exe");
const libraries = join(work, "libraries");
mkdirSync(libraries);
const imagePath = join(work, "image.png");
writeTestPng(imagePath);
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4586);
const driverUrl = `http://127.0.0.1:${port}`;
const { delay, until, assertions, assert, Session } = driverClient({ driverUrl, application, work });

const appData = join(work, "app-data");
const scriptSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const scriptSha256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const helperSha256 = createHash("sha256").update(readFileSync(new URL("./save-destination.helpers.mjs", import.meta.url))).digest("hex");
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const manifestPath = resolve(manifestArg ?? "work/e2e/t10-build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
if (manifest.binarySha256.toLowerCase() !== binarySha256) throw new Error("Binary does not match the build manifest");
const source = manifest.source;
const sourceTree = spawnSync("git", ["rev-parse", source + "^{tree}"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const provenance = { scriptSource, scriptSha256, helperSha256, sourceTree, manifestPath, driverSha256: createHash("sha256").update(readFileSync(resolve(edgeArg))).digest("hex") };
const driver = spawn(driverArg, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: appData, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});

let session, a, b, c, environment;
const receipts=[];
// The UI steps read the live session through this getter (stopApp sets it to null and restarts the app).
const { local, task, finish, dialogX, importDialog, libraryChoice, shown, choose, readyClick, openImport, startOpened, begin, exists, chooseNextTarget, shownCurrentName, browseAll, runningCard, createLibraryFromMenu } = importUi({ get session() { return session; } }, { until });
// End only this run's own application processes: descendants of this run's tauri-driver PID.
function ownAppPids(){
 const r=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","$all=Get-CimInstance Win32_Process;$set=@([int]$env:KINSHOKO_E2E_DRIVER);do{$n=$set.Count;$set=@($set+($all|Where-Object{$set -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId})|Select-Object -Unique)}while($set.Count -ne $n);$all|Where-Object{$set -contains [int]$_.ProcessId -and $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE}|ForEach-Object{$_.ProcessId}"],{env:{...process.env,KINSHOKO_E2E_DRIVER:String(driver.pid),KINSHOKO_E2E_EXECUTABLE:application},encoding:"utf8",windowsHide:true});
 return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
// 例外（#521）：这里按进程号用 taskkill 结束，与 lib/driver.mjs 的 quitOwnApp 做法不同，所以留在本地。
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
 if(process.argv.includes("--copy-only")){
   c=await session.invoke("create_library",{parent:libraries,name:"新浏览库 C"});
   await session.exec("location.reload();");
   await until("formal current C",()=>shownCurrentName("新浏览库 C"));
 }else{
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
 }
 const bCard=(await local(b.id,bFolder)).cards[0];
 await session.invoke("edit",{libraryId:b.id,ids:[bCard.imageId],edits:[{kind:"setNote",text:"B 原来源备注"}]});
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",scope:process.argv.includes("--copy-only")?"copy-only":"visible-owner-and-copy",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,finishedAt:new Date().toISOString()},null,2));
 console.log(`Evidence: ${work}`);
}catch(error){
 console.error(error);if(session){await session.screenshot("failure.png").catch(()=>{});await session.exec("return document.documentElement.outerHTML;").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",scope:process.argv.includes("--copy-only")?"copy-only":"visible-owner-and-copy",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,error:String(error)},null,2));process.exitCode=1;
}finally{
 await stopApp();if(driver.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
}
