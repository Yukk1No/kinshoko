// Same generated samples and CSS viewport as e2e/spec78-frontend.mjs, using the unchanged accepted prototype.
// Usage: node e2e/spec78-prototype.mjs <msedgedriver.exe> [evidence-directory]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
const [, , driverArg, outputArg = "docs/implementation/evidence/spec78-t01"] = process.argv;
if (!driverArg) throw new Error("Usage: node e2e/spec78-prototype.mjs <msedgedriver.exe> [evidence-directory]");
const output = resolve(outputArg);
const formal = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "kinshoko-spec78-prototype-"));
const port = 4470;
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4180", "--strictPort"], { cwd: resolve("prototype/reference-browser"), windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
const driver = spawn(resolve(driverArg), ["--port=" + port], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
const DRIVER = "http://127.0.0.1:" + port;
let base;
async function wd(method, path, body) {
  const response = await fetch(DRIVER + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const json = await response.json();
  if (!response.ok || json.value?.error) throw new Error(JSON.stringify(json));
  return json.value;
}
const exec = (script, args = []) => wd("POST", base + "/execute/sync", { script, args });
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const key = (value) => wd("POST",base+"/actions",{actions:[{type:"key",id:"keyboard",actions:[{type:"keyDown",value},{type:"keyUp",value}]}]});
const element = async (xpath) => (await wd("POST",base+"/element",{using:"xpath",value:xpath}))[ELEMENT];
const click = async (xpath) => wd("POST",base+"/element/"+await element(xpath)+"/click",{});
const until = async (label, read) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) { try { const result = await read(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Timeout: " + label);
};
const check = (ok, label) => { if (!ok) throw new Error(label); console.log("✓ " + label); };
try {
  await until("prototype server", () => fetch("http://127.0.0.1:4180").then(r => r.ok));
  await until("driver", () => fetch(DRIVER + "/status").then(r => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "MicrosoftEdge", "ms:edgeOptions": { args: ["--headless=new", "--user-data-dir=" + join(work, "profile"), "--force-device-scale-factor=" + formal.viewport.dpr, "--window-size=1280,800"] } } } });
  base = "/session/" + session.sessionId;
  await wd("POST", base + "/url", { url: "http://127.0.0.1:4180" });
  const target = formal.viewport;
  for (let i = 0; i < 4; i++) {
    const now = await exec("return {width:innerWidth,height:innerHeight}");
    if (now.width === target.width && now.height === target.height) break;
    const outer = await wd("GET", base + "/window/rect");
    await wd("POST", base + "/window/rect", { width: outer.width + target.width - now.width, height: outer.height + target.height - now.height });
  }
  await until("same sample image decode", () => exec("return document.querySelectorAll('.card[data-id]').length > 0 && [...document.querySelectorAll('.card img')].every(i=>i.complete&&i.naturalWidth>0)"));
  const viewport = await exec("return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent}");
  check(viewport.width === target.width && viewport.height === target.height && viewport.dpr === target.dpr, "Prototype and formal app use the same CSS viewport and DPR");
  const fonts = await wd("POST", base + "/execute/async", { script: "const done=arguments[arguments.length-1];document.fonts.ready.then(()=>done([...document.fonts].filter(f=>f.status==='loaded').length>=4));", args: [] });
  check(fonts, "Accepted prototype uses the same shipped fonts offline");
  const sample = JSON.parse(readFileSync(join(output,"sample-manifest.json"),"utf8")).find(i=>i.w===2400&&i.h===1600).id;
  writeFileSync(join(output, "prototype-wall.png"), Buffer.from(await wd("GET", base + "/screenshot"), "base64"));
  const browseMetrics=await exec("const c=document.querySelector('.card');return {cardRadius:getComputedStyle(c).borderRadius,wallTop:document.querySelector('.wall').getBoundingClientRect().top,cardTop:c.getBoundingClientRect().top,cardWidth:parseFloat(c.style.width),count:document.querySelector('.result-count').textContent,density:document.querySelector('.density input').value}");
  check(browseMetrics.cardRadius==='6px'&&browseMetrics.count==='43 张'&&browseMetrics.density==='240',"Accepted rounded cards, result count and density control match the formal baseline");
  await click("//input[@type='range']"); await key("\uE010"); await new Promise(r=>setTimeout(r,300));
  const larger=await until("larger density",()=>exec("const c=document.querySelector('.card');return document.querySelector('.density input').value==='420'&&parseFloat(c.style.width)>arguments[0]?parseFloat(c.style.width):null",[browseMetrics.cardWidth]));
  await key("\uE011");for(let i=0;i<10;i++)await key("\uE014"); await new Promise(r=>setTimeout(r,300));
  await until("restored density",()=>exec("return document.querySelector('.density input').value==='240'&&Math.abs(parseFloat(document.querySelector('.card').style.width)-arguments[0])<.01",[browseMetrics.cardWidth]));
  const densityCheck={initial:240,larger:420,restored:240,initialWidth:browseMetrics.cardWidth,largerWidth:larger};
  const card = await exec("return document.querySelector('[data-id=\"'+arguments[0]+'\"]')",[sample]);
  await wd("POST", base + "/element/" + card[ELEMENT] + "/click", {});
  await until("single click viewer", () => exec("const i=document.querySelector('.stage-image');return i&&i.complete&&i.naturalWidth===2400"));
  if(await exec("return document.querySelector('button[aria-label=信息]').getAttribute('aria-pressed')==='true'")) await click("//button[@aria-label='信息']");
  await click("//button[@title='背景：中灰']");
  await until("viewer fits same sample",()=>exec("return document.querySelector('.stage-image').getBoundingClientRect().width>500"));
  writeFileSync(join(output, "prototype-viewer.png"), Buffer.from(await wd("GET", base + "/screenshot"), "base64"));
  await wd("POST", base + "/actions", { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" }] }] });
  await until("return focus", () => exec("return !document.querySelector('.viewer') && document.activeElement?.dataset.id===arguments[0]", [sample]));
  check(true, "Unchanged accepted prototype single-clicks and returns focus to the same card");
  const anchor=await exec("const w=document.querySelector('.wall');w.scrollTop=720;w.dispatchEvent(new Event('scroll'));const top=w.getBoundingClientRect().top;const cards=[...w.querySelectorAll('.card')].map(c=>({id:c.dataset.id,r:c.getBoundingClientRect()})).filter(c=>c.r.bottom>top+8&&c.r.top<top+w.clientHeight).sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);return {id:cards[0].id,offset:cards[0].r.top-top}");
  const reading=await exec("const w=document.querySelector('.wall');const top=w.getBoundingClientRect().top;const c=[...w.querySelectorAll('.card')].find(c=>{const r=c.getBoundingClientRect();return r.top>=top&&r.bottom<=top+w.clientHeight});c.focus({preventScroll:true});return {id:c.dataset.id,top:w.scrollTop}");
  await key("\uE007");await until("keyboard viewer",()=>exec("return !!document.querySelector('.viewer')"));await key("\uE00C");
  await until("same scroll and focus",()=>exec("return !document.querySelector('.viewer')&&document.activeElement?.dataset.id===arguments[0].id&&Math.abs(document.querySelector('.wall').scrollTop-arguments[0].top)<.1",[reading]));
  const anchorStable=()=>exec("const w=document.querySelector('.wall');const c=w.querySelector('[data-id=\"'+arguments[0].id+'\"]');return c&&!c.getAnimations().some(a=>a.playState==='running')&&Math.abs(c.getBoundingClientRect().top-w.getBoundingClientRect().top-arguments[0].offset)<1",[anchor]);
  await exec("window.__T01_REFLOW__=[];document.querySelector('button[aria-label=收起侧栏]').addEventListener('click',()=>{const end=performance.now()+500;const frame=()=>{const w=document.querySelector('.wall');const c=document.querySelector('.card');window.__T01_REFLOW__.push({width:w.clientWidth,card:parseFloat(c.style.width)});if(performance.now()<end)requestAnimationFrame(frame)};requestAnimationFrame(frame)},{once:true})");
  await click("//button[@aria-label='收起侧栏']");await until("collapse anchor",anchorStable);
  writeFileSync(join(output,"prototype-collapsed.png"),Buffer.from(await wd("GET",base+"/screenshot"),"base64"));
  await click("//button[@aria-label='展开侧栏']");await until("expand anchor",anchorStable);
  const reflow=await exec("return window.__T01_REFLOW__");
  check(new Set(reflow.map(f=>f.card.toFixed(2))).size>2,"Accepted prototype continuously reflows and retains its reading anchor");
  for(const size of formal.resizeViewports){
    for(let i=0;i<4;i++){const now=await exec("return {width:innerWidth,height:innerHeight}");if(now.width===size.width&&now.height===size.height)break;const outer=await wd("GET",base+"/window/rect");await wd("POST",base+"/window/rect",{width:outer.width+size.width-now.width,height:outer.height+size.height-now.height});}
    await until("window resize anchor",anchorStable);
  }
  check(true,"Same density, single-click, return, sidebar and window-width steps completed in both apps");
  writeFileSync(join(output, "prototype-report.json"), JSON.stringify({ status: "passed", sourceCommit: "bd8aea44c4a311571ee3c07382cb7755f87f3153", viewport, fonts, browseMetrics,densityCheck,anchor,reading,reflow,resizeViewports:formal.resizeViewports,samples: formal.samples, singleClickReturnFocus: true, humanAcceptance: "unverified" }, null, 2));
} finally {
  if (base) await wd("DELETE", base).catch(() => {});
  driver.kill(); vite.kill();
  await new Promise(r => setTimeout(r, 1000));
  const target = resolve(work);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("kinshoko-spec78-prototype-")) throw new Error("Invalid test cleanup target");
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
