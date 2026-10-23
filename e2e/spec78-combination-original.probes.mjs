// originalCombination window focus, clipboard and painted-geometry probes; spec78-combination-original.mjs passes its stage context in.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { fileRecord } from "./spec78-combination-preflight.mjs";
import { sameRect, placement, python, purePixels } from "./spec78-combination-original.capture.mjs";

export function originalProbes(c) {
  const { d, workflow, fixture, original, session, state, save, desktop, native, windows, history, assertSession, observerManifest } = c;
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
  return { focusMain, clipboardMetadata, readClipboard, closePopup, paintedGeometry, wallOriginal, prepareWall, pinReady };
}
