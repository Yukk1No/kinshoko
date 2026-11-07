// spec78-frontend.mjs 的分段步骤：t 是主脚本的 WebDriver 上下文（wd、base、exec、find…）。
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export async function writePrototypeInput(t, { work, source, output }) {
  const { wd, base, exec, find, until, check, key, click, image, ELEMENT } = t;
  // Read only public IPC to copy the same imported sample order into the unchanged accepted prototype.
  const samples = await wd("POST", base + "/execute/async", {script: `const done=arguments[arguments.length-1]; (async()=>{ const invoke=window.__TAURI_INTERNALS__.invoke; const library=await invoke('plugin:library|current_library'); const safeMode=await invoke('plugin:library|safe_mode'); const page=await invoke('plugin:library|workspace_browse',{query:{scope:{kind:'library',libraryId:library.id,scope:{kind:'all'}},conditions:{conditions:[]},cursor:null,limit:500,knownPlaceholders:[]},safeMode}); const details=await Promise.all(page.cards.map(c=>invoke('plugin:library|image',{libraryId:library.id,imageId:c.sources.find(s=>s.libraryId===library.id).imageId}))); return details; })().then(done,e=>done({error:String(e)}));`, args:[]});
  if (!Array.isArray(samples)) throw new Error(JSON.stringify(samples));
  // Keep this independent 43-image input local; the final T20 comparison uses its own complete
  // actual public packet and a fresh accepted-code mirror, without replacing historical .local.
  const prototype = join(work, "prototype-input");
  mkdirSync(join(prototype,"media"),{recursive:true}); mkdirSync(join(prototype,"fonts"),{recursive:true});
  const manifest = samples.map((detail)=>{
    const original=join(source,detail.originalName); const data=readFileSync(original);
    copyFileSync(original,join(prototype,"media",detail.id+".png"));
    return {id:detail.id,sha256:createHash('sha256').update(data).digest('hex'),title:detail.originalName,date:new Date(detail.collectedAt).toISOString(),thumb:"media/"+detail.id+".png",view:"media/"+detail.id+".png",w:detail.width,h:detail.height,viewScale:1,format:"PNG",sourceTags:[],autoTags:[],autoModel:null,rating:{value:"general",from:"generated fixture"},sourceLinks:[],coverage:[],split:"validation"};
  });
  writeFileSync(join(prototype,"library.json"),JSON.stringify({images:manifest,tags:{}}));
  for(const weight of ["Regular","Medium","SemiBold"]) copyFileSync(resolve("public/fonts/Inter-"+weight+"-hinted.woff2"),join(prototype,"fonts","Inter-"+weight+".woff2"));
  copyFileSync(resolve("public/fonts/SourceHanSansSC-VF.ttf.woff2"),join(prototype,"fonts","SourceHanSansSC-VF.ttf.woff2"));
  writeFileSync(join(output,"sample-manifest.json"),JSON.stringify(manifest.map(({id,sha256,title,w,h})=>({id,sha256,title,w,h})),null,2));
  return manifest;
}

export async function folderSearchRoundTrip(t) {
  const { wd, base, exec, find, until, check, key, click, image, ELEMENT } = t;
  // Real multi-selection and a persisted folder/search round trip through the formal UI.
  // #114: 新建文件夹 lives in the library's ⋯ menu (also its right-click menu).
  await wd("POST", base + "/element/" + await find("//button[@aria-label='增量 T01 对照 的操作']") + "/click", {});
  await wd("POST", base + "/element/" + await until("新建文件夹菜单项", () => find("//*[@role='menuitem' and normalize-space()='新建文件夹']")) + "/click", {});
  const folderName=await find("//input[@aria-label='新文件夹名称']");
  await wd("POST",base+"/element/"+folderName+"/value",{text:"对照选集"});
  await key("\uE007");
  await until("文件夹已保存",()=>find("//button[@aria-label='对照选集（0 张）']"));
  // Folder creation refreshes the wall independently of the sidebar receipt.
  // Wait for the actual options instead of silently clicking an empty list.
  const selected=await until("多选前两张卡片",()=>exec("const cards=[...document.querySelectorAll('.card')].slice(0,2);return cards.length===2?cards:null"));
  await wd("POST",base+"/actions",{actions:[{type:"key",id:"keyboard",actions:[{type:"keyDown",value:"\uE009"}]}]});
  for(const node of selected) await wd("POST",base+"/element/"+(node[ELEMENT]??node.ELEMENT)+"/click",{});
  await wd("POST",base+"/actions",{actions:[{type:"key",id:"keyboard",actions:[{type:"keyUp",value:"\uE009"}]}]});
  await until("多选整理",()=>find("//*[normalize-space()='已选 2 张']"));
  // #98: 移到文件夹 is a menu on the floating selection bar.
  await until("移到文件夹按钮可用",()=>exec("const button=document.querySelector('[role=toolbar][aria-label=已选参考图操作] button[aria-label=移到文件夹]');return !!button&&!button.disabled"));
  await wd("POST",base+"/element/"+await find("//*[@role='toolbar' and @aria-label='已选参考图操作']//button[@aria-label='移到文件夹']")+"/click",{});
  await wd("POST",base+"/element/"+await until("放入菜单项",()=>find("//*[@role='menu']//*[@role='menuitem' and normalize-space()='对照选集']"))+"/click",{});
  await until("文件夹归属已保存",()=>find("//button[@aria-label='对照选集（2 张）']"));
  await wd("POST",base+"/element/"+await find("//button[@aria-label='对照选集（2 张）']")+"/click",{});
  await until("文件夹范围",()=>exec("return document.querySelector('.wall').dataset.total==='2'"));
  const search=await find("//input[@aria-label='查找参考图']");
  await wd("POST",base+"/element/"+search+"/value",{text:"没有对应标签"}); await key("\uE007");
  await until("真实查找结果",()=>exec("return document.querySelector('.wall').dataset.total==='0'"));
  await wd("POST",base+"/element/"+await find("//button[@aria-label='去掉这个条件']")+"/click",{});
  await until("清除查找仍在文件夹范围",()=>exec("return document.querySelector('.wall').dataset.total==='2'"));
  // The library's own row in the 查找范围 nav returns to its whole scope.
  await wd("POST",base+"/element/"+await find("//nav[@aria-label='查找范围']//button[@aria-label='增量 T01 对照（43 张）']")+"/click",{});
  await until("返回全部范围",()=>exec("return document.querySelector('.wall').dataset.total==='43'"));
  check(true,"Ctrl 多选、真实文件夹归属和查找清除后范围保持可用");
}

export async function escClosesActivePin(t) {
  const { wd, base, exec, find, until, check, key, click, image, ELEMENT } = t;
  // Pin two real native windows, then send Esc in only one of them.
  const mainHandle=await wd("GET",base+"/window");
  const pinCard=await exec("return [...document.querySelectorAll('.card')].find(c=>{const r=c.getBoundingClientRect();return r.top>=150&&r.bottom<innerHeight-50})");
  await wd("POST",base+"/element/"+(pinCard[ELEMENT]??pinCard.ELEMENT)+"/click",{}); await until("钉图前查看器",image);
  for(let i=0;i<2;i++) { await click("钉住整图"); await new Promise(r=>setTimeout(r,500)); }
  const handles=await until("两个原生钉图窗口",async()=>{const h=await wd("GET",base+"/window/handles");return h.length>=3?h:null;});
  const pinHandles=handles.filter(h=>h!==mainHandle);
  await wd("POST",base+"/window",{handle:pinHandles[0]});
  await until("钉图解码",()=>exec("return !!document.querySelector('.pin canvas')"));
  await key("\uE00C");
  await until("活动钉图已关闭",async()=>!(await wd("GET",base+"/window/handles")).includes(pinHandles[0]));
  const remaining=await wd("GET",base+"/window/handles");
  check(remaining.includes(pinHandles[1])&&remaining.includes(mainHandle),"Esc 关闭活动原生钉图，另一钉图和主窗口保持打开");
  await wd("POST",base+"/window",{handle:pinHandles[1]}); await key("\uE00C");
  await wd("POST",base+"/window",{handle:mainHandle});
}
