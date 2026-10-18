// T20 original-region stage. Import-safe: no desktop/process/clipboard observation on import.
// Reuses fixed T16/T17 public capture contracts and their granted native observers.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { literal, named } from "./spec78-combination-workflow.mjs";
import { fileRecord } from "./spec78-combination-preflight.mjs";

export const ORIGINAL_CONTRACT_SOURCE="1d188e52a9639319dbaf90de9fe46a9a6fcea9b3";
const sameRect=(a,b)=>["x","y","width","height"].every(key=>a?.[key]===b?.[key]);
const placement=()=>({flipH:false,flipV:false,rotation:0});
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
function python(script,args=[],input) {
  const observed=spawnSync(process.env.KINSHOKO_PYTHON??"python",[script,...args],{input:input===undefined?undefined:JSON.stringify(input),encoding:"utf8",windowsHide:true,env:{...process.env,PYTHONUTF8:"1"}});
  let value;
  try{value=JSON.parse(observed.stdout.replace(/^\uFEFF/,""));}catch{throw Error("Original-region helper produced no JSON: "+script+": "+observed.stderr);}
  return {executable:process.env.KINSHOKO_PYTHON??"python",args:[script,...args],exit:observed.status,error:observed.error?String(observed.error):null,stderr:observed.stderr,value};
}
function purePixels(request) {
  const result=python("e2e/spec78-combination-original-pixels.py",[],request);
  if(result.exit!==0&&!(request.mode==="compare"&&result.exit===1&&result.value.matches===false))throw Error("Pure original-file oracle failed: "+JSON.stringify(result));
  return result;
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
  const focusMain=()=>{
    const before=d.observeOwned();d.rememberOwned(before);
    const apps=before.processes.filter(item=>resolve(item.executable).toLowerCase()===d.application.toLowerCase());
    d.assert(apps.length===1&&!!apps[0].created,"original observer focuses one exact current owned application instance",apps);
    const result=python("e2e/native-wall-observe.py",[d.application,observerManifest,"focus"]);
    if(result.exit!==0||result.error)throw Error("Owned main foreground observation failed: "+JSON.stringify(result));
    const after=d.observeOwned();d.rememberOwned(after);
    const same=after.processes.find(item=>item.pid===apps[0].pid&&item.created===apps[0].created&&item.executable===apps[0].executable);
    d.assert(same&&result.value.pid===same.pid&&result.value.foregroundPid===same.pid&&result.value.foregroundHwnd===result.value.mainHwnd,"actual foreground HWND belongs to the same frozen application instance",{before:apps[0],after:same,observer:result});
    d.record("original-owned-main-focus",result);return result;
  };
  const clipboardMetadata=()=>{
    const observed=python("e2e/native-clipboard-observe.py");
    if(observed.exit!==0||observed.error)throw Error("Read-only clipboard metadata failed: "+JSON.stringify(observed));
    return observed.value;
  };
  const readClipboard=label=>{
    const path=join(d.work,"original-"+label+"-clipboard.png");
    if(existsSync(path))throw Error("Preserve the prior actual clipboard observation: "+path);
    const observed=python("e2e/native-wall-pixels.py",["clipboard",path]);
    if(observed.exit!==0||observed.error)throw Error("Actual clipboard RGBA read failed: "+JSON.stringify(observed));
    return {...observed.value,file:fileRecord(path),pixels:purePixels({mode:"inspect",actual:path}).value};
  };
  // #98: no import popup remains; close any open menu so the measured wall is unobstructed.
  const closePopup=()=>workflow.closeMenu();
  const paintedGeometry=async kind=>{
    const measured=await d.exec(`
const kind=arguments[0],id=arguments[1],original=arguments[2];
const card=kind==='wall'?[...document.querySelectorAll('.card')].find(node=>node.dataset.id===id):null;
const image=kind==='wall'?card?.querySelector('img'):document.querySelector('.viewer-stage img');
const clip=kind==='wall'?document.querySelector('.wall'):document.querySelector('.viewer-stage');
if(!image?.complete||!image.naturalWidth||!clip||card?.dataset.veiled==='true')return null;
const style=getComputedStyle(image);if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0)return null;
if(document.getAnimations?.().some(a=>a.playState==='running'&&a.effect?.target?.closest?.('.card,.viewer-stage')))return null;
const box=image.getBoundingClientRect(),limit=clip.getBoundingClientRect(),scale=Math.min(box.width/original.width,box.height/original.height),dpr=devicePixelRatio;
const shown={left:box.left+(box.width-original.width*scale)/2,top:box.top+(box.height-original.height*scale)/2,right:box.left+(box.width+original.width*scale)/2,bottom:box.top+(box.height+original.height*scale)/2};
const visible={left:Math.max(shown.left,limit.left,0),top:Math.max(shown.top,limit.top,0),right:Math.min(shown.right,limit.right,innerWidth),bottom:Math.min(shown.bottom,limit.bottom,innerHeight)};
const physical=(r,inset)=>{const l=(inset?Math.ceil:Math.round)(r.left*dpr),t=(inset?Math.ceil:Math.round)(r.top*dpr),right=(inset?Math.floor:Math.round)(r.right*dpr),bottom=(inset?Math.floor:Math.round)(r.bottom*dpr);return {x:l,y:t,width:right-l,height:bottom-t};};
const clipped=physical(visible,true);if(clipped.width<24||clipped.height<24)return null;
return {shown:physical(shown,false),visible:clipped,dpr,thumbnail:{width:image.naturalWidth,height:image.naturalHeight,src:image.currentSrc},wall:document.querySelector('.wall')?{width:document.querySelector('.wall').clientWidth,scrollTop:document.querySelector('.wall').scrollTop,scrollHeight:document.querySelector('.wall').scrollHeight,total:document.querySelector('.wall').dataset.total,ids:[...document.querySelectorAll('.card')].map(node=>node.dataset.id)}:null,viewport:{width:innerWidth,height:innerHeight}};
`,[kind,workflow.targetA.contentId,{width:original.width,height:original.height}]);
    if(!measured)return null;
    const origin=await native("inner_position");
    return {kind,windowLabel:"main",target:workflow.targetA,sourceWidth:original.width,sourceHeight:original.height,crop:null,placement:placement(),...measured,origin,shown:{...measured.shown,x:measured.shown.x+origin.x,y:measured.shown.y+origin.y},visible:{...measured.visible,x:measured.visible.x+origin.x,y:measured.visible.y+origin.y}};
  };
  const wallOriginal=async()=>{
    await d.main();await until("the same A original is mounted after real virtual wall scroll",async()=>{
      await d.exec("const wall=document.querySelector('.wall');if(!wall)throw Error('missing real wall');const card=[...wall.querySelectorAll('.card')].find(node=>node.dataset.id===arguments[0]);if(card)card.scrollIntoView({block:'center',inline:'nearest'});else wall.scrollTop=wall.scrollHeight;",[workflow.targetA.contentId]);
      return paintedGeometry("wall");
    });
    return until("the returned original thumbnail is painted and layout settled",()=>paintedGeometry("wall"));
  };
  const prepareWall=async()=>{
    await d.main();focusMain();await closePopup();
    return wallOriginal();
  };
  const pinReady=async id=>{
    await d.main();
    const readyFrame=await until("exact reference pin is visible and available",async()=>{const frame=await desktop("pin_frame",{pin:id});return frame&&!frame.veiled&&!frame.unavailable&&sameRect(frame.window,frame.content)&&await native("is_visible","pin-"+id)?frame:null;});
    await d.window("pin-"+id);
    const paint=await until("real pin canvas is ready for the native painted-image check",()=>d.exec(`
const canvas=document.querySelector('.pin-canvas');if(!canvas||!canvas.width||!canvas.height||document.querySelector('.pin-missing,.pin-runtime-problem [role=alert]')||document.querySelector('.pin')?.classList.contains('pin-veiled'))return null;
if(document.getAnimations?.().some(a=>a.playState==='running'))return null;
const b=canvas.getBoundingClientRect(),box={x:Math.round(b.left*devicePixelRatio),y:Math.round(b.top*devicePixelRatio),width:Math.round(b.right*devicePixelRatio)-Math.round(b.left*devicePixelRatio),height:Math.round(b.bottom*devicePixelRatio)-Math.round(b.top*devicePixelRatio)};
if(!['x','y','width','height'].every(key=>box[key]===arguments[0][key]))return null;
try{const context=canvas.getContext('2d'),points=[[.3,.3],[.5,.5],[.7,.7]],pixels=points.map(([x,y])=>[...context.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data]);if(!pixels.some(p=>p[3]>0&&(p[0]!==138||p[1]!==138||p[2]!==142)))return null;return {width:canvas.width,height:canvas.height,pixels,box};}catch(error){if(error?.name==='SecurityError')return {width:canvas.width,height:canvas.height,box,canvasReadback:'blocked-by-browser',reason:String(error)};throw error;}
`,[{x:readyFrame.content.x-readyFrame.window.x,y:readyFrame.content.y-readyFrame.window.y,width:readyFrame.content.width,height:readyFrame.content.height}]));
    const frame=await desktop("pin_frame",{pin:id}),origin=await native("inner_position","pin-"+id),size=await native("inner_size","pin-"+id),dpr=await d.exec("return devicePixelRatio;");
    d.assert(!frame.veiled&&!frame.unavailable&&sameRect(frame.window,frame.content)&&origin.x===frame.window.x&&origin.y===frame.window.y&&size.width===frame.window.width&&size.height===frame.window.height&&paint.width===frame.content.width&&paint.height===frame.content.height,"pin geometry and actual canvas dimensions agree with its native view",{frame,origin,size,paint});
    return {kind:"pin",windowLabel:"pin-"+id,pinId:id,target:{libraryId:frame.pin.content.libraryId,imageId:frame.pin.content.imageId,contentId:workflow.targetB.contentId},sourceWidth:frame.pin.content.sourceWidth,sourceHeight:frame.pin.content.sourceHeight,crop:frame.pin.crop,placement:frame.pin.placement,shown:frame.content,visible:frame.content,dpr,origin,frame,paint};
  };
  const pointer=async actions=>d.request("POST",d.session+"/actions",{actions:[{type:"pointer",id:"original-region-mouse",parameters:{pointerType:"mouse"},actions}]});
  const beginSelection=async(label,readSource)=>{
    const source=await readSource(),origin=await native("inner_position",source.windowLabel),dpr=await d.exec("return devicePixelRatio;");
    // Actual WebDriver pointer placement chooses the same physical monitor for F1.
    await pointer([{type:"pointerMove",duration:0,origin:"viewport",x:Math.round((source.visible.x+source.visible.width/2-origin.x)/dpr),y:Math.round((source.visible.y+source.visible.height/2-origin.y)/dpr)}]);
    const beforeHistory=await history(),beforeClipboard=clipboardMetadata(),beforeWindows=await windows();
    await desktop("start_capture");
    const handle=await d.window("capture");
    const raster=await until("painted full native capture overlay",async()=>{
      if(!await native("is_visible","capture"))return null;
      return d.exec("const i=document.querySelector('.capture-screen');if(!i?.complete||!i.naturalWidth)return null;const b=i.getBoundingClientRect();return {dpr:devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},image:{x:b.x,y:b.y,width:b.width,height:b.height},natural:{width:i.naturalWidth,height:i.naturalHeight}};");
    });
    const frozen=await desktop("frozen_screen"),captureOrigin=await native("inner_position","capture");
    d.assert(frozen&&frozen.image.startsWith("screen/")&&Math.abs(raster.image.x)+Math.abs(raster.image.y)<.01&&Math.abs(raster.image.width*raster.dpr-frozen.width)<.01&&Math.abs(raster.image.height*raster.dpr-frozen.height)<.01,"real capture overlay paints the physical frozen monitor: "+label,{frozen,raster,captureOrigin});
    await d.window(source.windowLabel);
    const after=source.kind==="pin"?await pinReady(source.pinId):await paintedGeometry(source.kind);
    d.assert(after&&sameRect(source.shown,after.shown)&&sameRect(source.visible,after.visible)&&source.target.libraryId===after.target.libraryId&&source.target.imageId===after.target.imageId,"measured source stays fixed across the production capture handshake: "+label,{before:source,after});
    await d.window("capture");
    const x=source.visible.x+Math.floor(source.visible.width/4)-captureOrigin.x,y=source.visible.y+Math.floor(source.visible.height/4)-captureOrigin.y,width=Math.max(5,Math.floor(source.visible.width/6)),height=Math.max(5,Math.floor(source.visible.height/6));
    d.assert(x>=0&&y>=0&&x+width<frozen.width&&y+height<frozen.height,"this capture monitor wholly contains the actual reference selection: "+label,{x,y,width,height,frozen});
    const css={x:Math.round(x/raster.dpr),y:Math.round(y/raster.dpr),right:Math.round((x+width)/raster.dpr),bottom:Math.round((y+height)/raster.dpr)};
    await pointer([{type:"pointerMove",duration:0,origin:"viewport",x:css.x,y:css.y},{type:"pointerDown",button:0},{type:"pointerMove",duration:80,origin:"viewport",x:css.right,y:css.bottom},{type:"pointerUp",button:0}]);
    const feedback=await until("actual complete selection and capture buttons",()=>d.exec(`
const selection=document.querySelector('.capture-selection'),tools=document.querySelector('.capture-tools [role=toolbar][aria-label=截图]'),size=tools?.querySelector('.k-dock-readout b');if(!selection||!tools||!size)return null;
const buttons=[...tools.querySelectorAll('button')].map(node=>{const b=node.getBoundingClientRect();return {text:(node.getAttribute('aria-label')??node.textContent).split('，')[0].trim(),name:node.getAttribute('aria-label'),disabled:node.disabled,visible:b.width>0&&b.height>0&&b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,box:{x:b.x,y:b.y,width:b.width,height:b.height}};});
const region=Object.fromEntries(['x','y','width','height'].map((key,i)=>[key,Math.round(parseFloat(selection.style[['left','top','width','height'][i]])*devicePixelRatio)]));
const b=size.getBoundingClientRect();return {region,size:size.textContent.trim(),sizeFullyVisible:b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,buttons,dpr:devicePixelRatio};
`));
    d.assert(feedback.buttons.length===3&&feedback.buttons.every(button=>button.visible&&!button.disabled)&&JSON.stringify(feedback.buttons.map(button=>button.text))===JSON.stringify(["复制","钉住","取消"])&&feedback.sizeFullyVisible&&feedback.size===feedback.region.width+" × "+feedback.region.height,"actual capture size and all three action controls remain fully visible: "+label,feedback);
    const selected={...feedback.region,x:feedback.region.x+captureOrigin.x,y:feedback.region.y+captureOrigin.y};
    d.assert(selected.x>=source.visible.x&&selected.y>=source.visible.y&&selected.x+selected.width<=source.visible.x+source.visible.width&&selected.y+selected.height<=source.visible.y+source.visible.height,"actual rounded overlay selection remains wholly inside the measured source: "+label,{selected,source});
    const expected=purePixels({mode:"describe",original:original.path,source,selected}).value;
    const screenshot="original-"+label+"-selection.png";await d.screenshot(screenshot);
    const frozenPixels=purePixels({mode:"frozen",actual:join(d.work,screenshot),frozen:{width:frozen.width,height:frozen.height},region:feedback.region}).value;
    d.assert(frozenPixels.paintedNonuniform,"actual frozen selection contains painted image detail before the action: "+label,frozenPixels);
    const sample={label,status:"selected",source,after,token:frozen.image.slice(7),handle,raster,captureOrigin,region:feedback.region,selected,feedback,expected,beforeHistory,beforeClipboard,beforeWindows,selectionScreenshot:fileRecord(join(d.work,screenshot)),frozenPixels};
    state.samples.push(sample);save();return sample;
  };
  const waitCaptureGone=async sample=>{
    await until("exact capture overlay is destroyed: "+sample.label,async()=>!(await d.request("GET",d.session+"/window/handles")).includes(sample.handle));
    await d.main();
  };
  const capture=async(label,readSource,action)=>{
    const sample=await beginSelection(label,readSource);
    await workflow.readyClick("//div[contains(@class,'capture-tools')]//*[@role='toolbar' and @aria-label='截图']//button["+named(action==="copy"?"复制":"钉住")+"]");
    await waitCaptureGone(sample);
    if(action==="copy") {
      sample.afterClipboard=await until("original copy commits a new stable real clipboard image: "+label,()=>{const value=clipboardMetadata();return value.stableSequence&&value.sequence!==sample.beforeClipboard.sequence?value:null;});
      sample.clipboard=readClipboard(label);
      sample.comparison=purePixels({mode:"compare",original:original.path,source:sample.source,selected:sample.selected,actual:sample.clipboard.file.path});save();
      d.assert(sample.comparison.exit===0&&sample.comparison.value.matches,"actual clipboard equals every original RGBA pixel and dimension: "+label,sample.comparison);
      const dimensions=sample.comparison.value.actual.size;
      d.assert(dimensions[0]>sample.region.width&&dimensions[1]>sample.region.height&&sample.comparison.value.actual.alphaExtrema[0]===128,"copy preserves original detail and alpha above frozen-screen resolution: "+label,{dimensions,physicalSelection:sample.region,alpha:sample.comparison.value.actual.alphaExtrema,frozenPixels:sample.frozenPixels});
    } else {
      const labelNew=await until("one actual new native original reference pin: "+label,async()=>(await windows()).find(value=>value.startsWith("pin-")&&!sample.beforeWindows.includes(value)));
      sample.pin=await pinReady(labelNew.slice(4));const content=sample.pin.frame.pin.content,p=sample.pin.frame.pin.placement;
      d.assert(content.kind==="reference"&&content.libraryId===sample.source.target.libraryId&&content.imageId===sample.source.target.imageId&&content.sourceWidth===original.width&&content.sourceHeight===original.height&&sameRect(sample.pin.frame.pin.crop,sample.expected.crop)&&sample.pin.frame.pin.width===sample.expected.crop.width&&sample.pin.frame.pin.height===sample.expected.crop.height&&p.flipH===sample.source.placement.flipH&&p.flipV===sample.source.placement.flipV&&p.rotation===sample.source.placement.rotation,"actual pin preserves the exact provider, original crop and affine placement: "+label,sample.pin);
      await d.closePin(sample.pin.pinId);
    }
    sample.afterHistory=await history();save();
    d.assert(JSON.stringify(sample.afterHistory)===JSON.stringify(sample.beforeHistory),"original "+action+" adds no ordinary screenshot history: "+label,{before:sample.beforeHistory,after:sample.afterHistory});
    await assertSession(label);sample.status="verified-original-"+action;save();return sample;
  };
  const rejectedCopy=async sample=>{
    await d.main();
    // Return business failure as data. HTTP/WebDriver failures cannot satisfy this assertion.
    const response=await d.async("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:desktop|finish_capture',arguments[0]).then(value=>done({ok:true,value}),error=>done({ok:false,failure:String(error)}));",[{token:sample.token,region:sample.region,action:"copy"}]);
    sample.finish=response;await waitCaptureGone(sample);
    sample.afterClipboard=readClipboard(sample.label+"-after");sample.afterHistory=await history();save();
    d.assert(response.ok===false&&typeof response.failure==="string"&&response.failure.length>0&&JSON.stringify(sample.beforeHistory)===JSON.stringify(sample.afterHistory),"known invalid frozen source returns a business error without screen-history fallback: "+sample.label,response);
    d.assert(sample.clipboardBefore.pixels.rgbaSha256===sample.afterClipboard.pixels.rgbaSha256&&JSON.stringify(sample.clipboardBefore.pixels.size)===JSON.stringify(sample.afterClipboard.pixels.size),"known invalid frozen source preserves actual clipboard RGBA and dimensions: "+sample.label,{before:sample.clipboardBefore,after:sample.afterClipboard});
    sample.status="verified-rejection";save();
  };

  // Owner decision (2026-10-11): moving the frozen A image source to the recycle bin does not invalidate
  // the frozen selection. The copy must be allowed (no error, no crash) and come from the A original region,
  // never from screen pixels, and it must not add ordinary screenshot history.
  const trashedSourceCopy=async sample=>{
    await d.main();
    const response=await d.async("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:desktop|finish_capture',arguments[0]).then(value=>done({ok:true,value}),error=>done({ok:false,failure:String(error)}));",[{token:sample.token,region:sample.region,action:"copy"}]);
    sample.finish=response;await waitCaptureGone(sample);
    sample.afterHistory=await history();
    d.assert(JSON.stringify(sample.beforeHistory)===JSON.stringify(sample.afterHistory),"a frozen source moved to the recycle bin never adds ordinary screenshot history: "+sample.label,response);
    d.assert(response.ok===true,"copying from a frozen image source that was moved to the recycle bin is allowed (owner decision): no error, no crash: "+sample.label,response);
    sample.afterClipboard=await until("trashed-source copy commits a stable clipboard image",()=>{const value=clipboardMetadata();return value.stableSequence&&value.sequence!==sample.clipboardBefore.sequence?value:null;});
    sample.clipboard=readClipboard(sample.label+"-after");
    sample.comparison=purePixels({mode:"compare",original:original.path,source:sample.source,selected:sample.selected,actual:sample.clipboard.file.path});
    d.assert(sample.comparison.exit===0&&sample.comparison.value.matches,"the allowed copy is the exact A original region, never screen pixels: "+sample.label,sample.comparison);
    sample.policy="copy-allowed-from-trashed-source-original";
    sample.status="verified-trashed-source-"+sample.policy;save();
  };
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
