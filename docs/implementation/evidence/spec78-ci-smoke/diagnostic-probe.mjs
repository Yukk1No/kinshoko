// Isolated diagnostic reproduction. This file is not a replacement for the CI smoke test.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const application = resolve('work/v1-handoff/follow-up-spec/evidence/t05-native/worker-t05/nativeproof/f7ef52b1/kinshoko.exe');
const expected = '7dca4915d39d648f5b0e7b615671d316b3e63b187ee97a44d4cbb2f8ed3ff239';
if (createHash('sha256').update(readFileSync(application)).digest('hex') !== expected) throw Error('wrong diagnostic product');
const work = resolve(`work/v1-handoff/follow-up-spec/ci-smoke-probe-${Date.now()}`);
const parent = join(work, 'libraries');
mkdirSync(parent, { recursive: true });
const port = 4478, url = `http://127.0.0.1:${port}`;
const driver = spawn('C:/Users/yuk1no/.cargo/bin/tauri-driver.exe', ['--port', String(port), '--native-port', String(port+1), '--native-driver', 'C:/Users/yuk1no/.codex/worktrees/spec78-t01-frontend/kinshoko/work/e2e/tools/msedgedriver.exe'], { env: { ...process.env, KINSHOKO_DATA_DIR: join(work, 'app-data'), KINSHOKO_SKIP_AUTOSTART: '1', WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview') }, windowsHide:true, stdio:['ignore','inherit','inherit'] });
let base, result = { productSource:'f7ef52b12681ed679927f7fef034629b923ae8ec', binarySha256:expected, application, work, identifier:'dev.kinshoko.spec78t05test', ciSource:'fad93218cc56ee31b77460e1b4ef0b1d8127ab3b', ports:[port,port+1] };
const pause = ms => new Promise(r => setTimeout(r,ms));
async function wd(method,path,body) { const r=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); const j=await r.json(); if(!r.ok) throw Error(`${method} ${path}: ${JSON.stringify(j)}`); return j.value; }
async function until(f,ms=15000) { let e; const end=Date.now()+ms; while(Date.now()<end) {try{const v=await f();if(v)return v;}catch(x){e=x;} await pause(150);} throw e||Error('timed out'); }
const exec = (script,args=[])=>wd('POST',base+'/execute/sync',{script,args});
const find=async xpath=>(await wd('POST',base+'/element',{using:'xpath',value:xpath}))['element-6066-11e4-a52e-4f735466cecf'];
const click=async xpath=>wd('POST',base+'/element/'+await find(xpath)+'/click',{});
try {
  await until(()=>fetch(url+'/status').then(r=>r.ok));
  const s=await wd('POST','/session',{capabilities:{alwaysMatch:{'tauri:options':{application}}}}); base='/session/'+s.sessionId;
  await until(()=>find("//button[normalize-space()='建立资料库']"));
  const name=await find("//label[contains(., '资料库名称')]/input");
  await wd('POST',base+'/element/'+name+'/clear',{});
  await wd('POST',base+'/element/'+name+'/value',{text:'冒烟测试库'});
  await exec('window.__KINSHOKO_TEST_PICKS__=[arguments[0]]',[parent]);
  await click("//button[normalize-space()='选择存放位置…']");
  await until(()=>exec('return document.body.innerText.includes(arguments[0])',[parent]));
  await click("//button[normalize-space()='建立资料库']");
  await until(()=>exec("return [...document.querySelectorAll('select[aria-label=\"当前资料库\"] option')].some(o=>o.selected&&o.textContent.includes('冒烟测试库'))"));
  await pause(2500);
  result.current = await wd('POST',base+'/execute/async',{script:"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:library|current_library').then(value=>done({value}),error=>done({error:String(error)}));",args:[]});
  result.dom=await exec("return {headings:[...document.querySelectorAll('h1')].map(n=>n.textContent),text:document.body.innerText,selected:[...document.querySelectorAll('select[aria-label=\"当前资料库\"] option:checked')].map(n=>({value:n.value,text:n.textContent}))}");
  result.originalPredicate=await exec("return [...document.querySelectorAll('h1')].some(h=>h.textContent.trim()==='冒烟测试库')");
  writeFileSync(join(work,'page.html'),await exec('return document.documentElement.outerHTML'));
  writeFileSync(join(work,'created-library.png'),Buffer.from(await wd('GET',base+'/screenshot'),'base64'));
  result.correctedPredicate=result.dom.selected.some(option=>option.value===result.current.value?.id&&option.text.includes('冒烟测试库'));
  if(process.argv.includes('--corrected')) {
    if(!result.correctedPredicate) throw Error('current-library selector does not identify the created library');
    result.status='passed';
  } else {
    if(!result.originalPredicate) throw Error('CI exact symptom: the library is created/current, but //h1[normalize-space()=冒烟测试库] does not exist');
    result.status='unexpected-pass';
  }
} catch(e) { result.status='failed';result.error=String(e);process.exitCode=1;console.error(result.error); }
finally {
  if(base) await wd('DELETE',base).catch(()=>{});
  spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_PROBE_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],{env:{...process.env,KINSHOKO_PROBE_EXE:application},windowsHide:true,encoding:'utf8'});
  driver.kill();
  await pause(900);
  const inventory=spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',"$own=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_PROBE_EXE -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like ('*'+$env:KINSHOKO_PROBE_PROFILE+'*')) -or ($_.Name -in @('msedgedriver.exe','tauri-driver.exe') -and $_.CommandLine -match '(4478|4479)') }; $own | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Depth 3"],{env:{...process.env,KINSHOKO_PROBE_EXE:application,KINSHOKO_PROBE_PROFILE:join(work,'webview')},windowsHide:true,encoding:'utf8'});
  result.cleanupInventory=inventory.stdout.trim();result.cleanupError=inventory.stderr.trim();
  writeFileSync(join(work,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,work,headings:result.dom?.headings,current:result.current,originalPredicate:result.originalPredicate,cleanup:result.cleanupInventory}));
}
