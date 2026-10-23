// originalCombination selection, capture and rejected/trashed-source copy steps; spec78-combination-original.mjs passes its stage context in.
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { until } from "./spec78-combination-driver.mjs";
import { named } from "./spec78-combination-workflow.mjs";
import { fileRecord } from "./spec78-combination-preflight.mjs";

export const sameRect=(a,b)=>["x","y","width","height"].every(key=>a?.[key]===b?.[key]);
export const placement=()=>({flipH:false,flipV:false,rotation:0});
export function python(script,args=[],input) {
  const observed=spawnSync(process.env.KINSHOKO_PYTHON??"python",[script,...args],{input:input===undefined?undefined:JSON.stringify(input),encoding:"utf8",windowsHide:true,env:{...process.env,PYTHONUTF8:"1"}});
  let value;
  try{value=JSON.parse(observed.stdout.replace(/^\uFEFF/,""));}catch{throw Error("Original-region helper produced no JSON: "+script+": "+observed.stderr);}
  return {executable:process.env.KINSHOKO_PYTHON??"python",args:[script,...args],exit:observed.status,error:observed.error?String(observed.error):null,stderr:observed.stderr,value};
}
export function purePixels(request) {
  const result=python("e2e/spec78-combination-original-pixels.py",[],request);
  if(result.exit!==0&&!(request.mode==="compare"&&result.exit===1&&result.value.matches===false))throw Error("Pure original-file oracle failed: "+JSON.stringify(result));
  return result;
}

export function originalCapture(c) {
  const { d, workflow, fixture, original, session, state, save, desktop, native, windows, history, assertSession, observerManifest, focusMain, clipboardMetadata, readClipboard, closePopup, paintedGeometry, wallOriginal, prepareWall, pinReady } = c;
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
const selection=document.querySelector('.capture-selection'),tools=document.querySelector('.capture-tools [role=toolbar][aria-label=截图]'),size=tools?.querySelector('.k-dock-readout > span[title]');if(!selection||!tools||!size)return null;
const buttons=[...tools.querySelectorAll('button')].map(node=>{const b=node.getBoundingClientRect();return {text:(node.getAttribute('aria-label')??node.textContent).split('，')[0].trim(),name:node.getAttribute('aria-label'),disabled:node.disabled,visible:b.width>0&&b.height>0&&b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,box:{x:b.x,y:b.y,width:b.width,height:b.height}};});
const region=Object.fromEntries(['x','y','width','height'].map((key,i)=>[key,Math.round(parseFloat(selection.style[['left','top','width','height'][i]])*devicePixelRatio)]));
const b=size.getBoundingClientRect();return {region,size:[...size.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim(),sizeFullyVisible:b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,buttons,dpr:devicePixelRatio};
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
  return { pointer, beginSelection, waitCaptureGone, capture, rejectedCopy, trashedSourceCopy };
}
