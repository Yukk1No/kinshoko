// T20 same-session public packet and unchanged accepted-prototype comparison.
// Import-safe. No compiler, browser, server, clipboard, registry or installer runs on import.
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { until } from "./spec78-combination-driver.mjs";
import { literal } from "./spec78-combination-workflow.mjs";
import { fileRecord, ownedWork, readJson, sourceRecord } from "./spec78-combination-preflight.mjs";

export const ACCEPTED_PROTOTYPE="bd8aea44c4a311571ee3c07382cb7755f87f3153";
const prototypeRoot=resolve("prototype/reference-browser");
const fontNames=[
  ["Inter-Regular-hinted.woff2","Inter-Regular.woff2","338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1"],
  ["Inter-Medium-hinted.woff2","Inter-Medium.woff2","7e80d9f65861ee6836a0081d4e75d88fb8789e5651d05edbc49640442a9610ee"],
  ["Inter-SemiBold-hinted.woff2","Inter-SemiBold.woff2","5013f48d77ab627b1db7c2415914284ef09abc3f60a8e0d0d8f3cd1bfebefb5e"],
  ["SourceHanSansSC-VF.ttf.woff2","SourceHanSansSC-VF.ttf.woff2","cfec773cdc2ea964de8713471c6fd20774bc40617f5567f92efeeccaca6604b0"],
];
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Error(message);};
function writeNew(path,value) {
  if(existsSync(path))fail("Preserve the existing prototype output: "+path);
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,typeof value==="string"?value:JSON.stringify(value,null,2),{flag:"wx"});
}
function verifiedFile(expected,label) {
  const actual=fileRecord(expected.path);
  if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)fail(label+" bytes changed: "+actual.path);
  return actual;
}
function within(child,parent) {
  const name=relative(resolve(parent),resolve(child));
  return name!==""&&!isAbsolute(name)&&name!==".."&&!name.startsWith(".."+sep);
}
function git(args) {
  const result=spawnSync("git",args,{encoding:"utf8",windowsHide:true});
  if(result.status!==0)fail("Readonly prototype Git observation failed: "+result.stderr);
  return result.stdout.trim();
}
export function prototypeCodeRecord() {
  if(git(["diff","--name-only",ACCEPTED_PROTOTYPE,"--","prototype/reference-browser"]))fail("Do not change the accepted prototype code for this comparison");
  const files={};
  for(const path of git(["ls-files","-z","--","prototype/reference-browser"]).split("\0").filter(Boolean)) {
    const record=fileRecord(path),name=relative(prototypeRoot,record.path).replaceAll("\\","/");
    if(name.startsWith("../")||name.startsWith(".local/"))fail("Unexpected accepted prototype input");
    files[name]={...record};
  }
  if(!files["vite.config.ts"]||!files["src/seed.ts"]||!files["src/App.tsx"])fail("The accepted prototype tracked code is incomplete");
  return {acceptedSource:ACCEPTED_PROTOTYPE,files};
}
export function fontFileRecords() {
  return fontNames.map(([formal,prototype,sha256])=>{
    const record=fileRecord(join("public/fonts",formal));
    if(record.sha256!==sha256)fail("The accepted shipped font changed: "+formal);
    return {...record,formal,prototype};
  });
}
export function localInventory(root=join(prototypeRoot,".local")) {
  const path=resolve(root),files={};
  if(!existsSync(path))return {path,exists:false,files};
  const visit=base=>{
    for(const name of readdirSync(base).sort()) {
      const child=join(base,name),stat=lstatSync(child);
      if(stat.isSymbolicLink())fail("Do not traverse an existing prototype input link: "+child);
      if(stat.isDirectory())visit(child);
      else if(stat.isFile()){const record=fileRecord(child);files[relative(path,child).replaceAll("\\","/")]={bytes:record.bytes,sha256:record.sha256};}
      else fail("Unexpected existing prototype input entry: "+child);
    }
  };
  visit(path);return {path,exists:true,files};
}
// Validate the public snapshot, not DOM virtualization count or a reconstructed database rule.
export function validatePublicPages(pages,libraryId) {
  if(!Array.isArray(pages)||!pages.length)fail("The full actual public pagination is required");
  const revision=pages[0].response?.status?.revision,total=pages[0].response?.total,ids=new Set(),cards=[];
  if(typeof revision!=="string"||!Number.isSafeInteger(total)||total<0)fail("Missing actual public revision/total");
  let expectedCursor=null;
  for(const [index,page] of pages.entries()) {
    const response=page.response;
    if(!equal(page.cursor,expectedCursor)||response.status?.revision!==revision||response.total!==total||!Array.isArray(response.cards))fail("Public pages cannot mix cursor/revision/total snapshots");
    for(const card of response.cards) {
      if(!/^[0-9a-f]{64}$/.test(card.id??"")||ids.has(card.id))fail("Missing or duplicate public content identity");
      if(!Number.isSafeInteger(card.width)||!Number.isSafeInteger(card.height)||card.width<=0||card.height<=0)fail("Missing public original dimensions");
      const sources=card.sources.filter(source=>source.libraryId===libraryId&&source.matches&&!source.deleted&&source.unavailable===null);
      if(sources.length!==1)fail("An unambiguous available matching A source is required: "+card.id);
      if(card.libraryId!==libraryId||card.imageId!==sources[0].imageId)fail("The public display source must be the selected A provider");
      if(card.adult!==false)fail("A global-safe public packet cannot include an Adult card");
      ids.add(card.id);cards.push(card);
    }
    expectedCursor=response.nextCursor;
    if(expectedCursor!==null&&(typeof expectedCursor!=="string"||index===pages.length-1))fail("The actual public snapshot is not fully paged");
    if(expectedCursor===null&&index!==pages.length-1)fail("Pages were appended after public pagination ended");
  }
  if(expectedCursor!==null||cards.length!==total)fail("Actual public cards do not equal the completed total");
  return {revision,total,order:cards.map(card=>card.id),cards};
}
export function pngDimensions(path) {
  const data=readFileSync(path);
  if(data.length<33||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.toString("ascii",12,16)!=="IHDR")fail("Expected an exact original PNG input");
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if(!width||!height)fail("Empty PNG original");
  return {width,height};
}
export function fixtureInputIndex(fixture) {
  const byHash=new Map(),seen=new WeakSet();
  const visit=(node,depth=0)=>{
    if(node===null||typeof node!=="object")return;
    if(depth>12||seen.has(node))fail("Unexpected cyclic/deep fixture inputs");
    seen.add(node);
    if(typeof node.path==="string"&&typeof node.sha256==="string"&&Number.isSafeInteger(node.bytes)&&Number.isSafeInteger(node.width)&&Number.isSafeInteger(node.height)) {
      if(!within(node.path,fixture.root))fail("Public original mapping must remain in this round's owned fixture");
      const actual=verifiedFile(node,"Actual fixture original"),size=pngDimensions(actual.path);
      if(size.width!==node.width||size.height!==node.height)fail("Actual fixture original dimensions changed");
      const entry={...actual,...size};
      if(byHash.has(actual.sha256)&&!equal({...byHash.get(actual.sha256),path:null},{...entry,path:null}))fail("Inconsistent duplicate fixture bytes");
      if(!byHash.has(actual.sha256))byHash.set(actual.sha256,entry);
    }
    for(const value of Object.values(node))visit(value,depth+1);
  };
  visit(fixture.inputs);
  return byHash;
}
export function adaptPublicPacket(packet) {
  const snapshot=validatePublicPages(packet.pages,packet.libraryId),images=[],unknownAdaptations=[];
  for(const card of snapshot.cards) {
    const inspected=packet.inspections[card.id],detail=inspected?.value?.detail,original=packet.originals[card.id];
    const matching=card.sources.find(source=>source.libraryId===packet.libraryId&&source.matches&&!source.deleted&&source.unavailable===null);
    if(!inspected||!equal(inspected.target,{libraryId:packet.libraryId,imageId:matching.imageId,contentId:card.id})||detail?.id!==matching.imageId||detail.deletedAt!==null||detail.width!==card.width||detail.height!==card.height||original?.sha256!==card.id||original.width!==card.width||original.height!==card.height)fail("The exact A public source, inspection and original must agree: "+card.id);
    if(!Number.isSafeInteger(detail.collectedAt))fail("Preserve the actual collectedAt milliseconds");
    const date=new Date(detail.collectedAt).toISOString(),effective=detail.rating.effective;
    if(effective!==null&&!["general","sensitive","questionable","explicit"].includes(effective))fail("Unsupported actual public rating");
    if(effective===null)unknownAdaptations.push({contentId:card.id,actualEffective:null,prototypeStandIn:"general",ratingComparison:"unverified"});
    images.push({id:card.id,sha256:card.id,title:detail.originalName,date,thumb:"media/"+card.id+".png",view:"media/"+card.id+".png",w:card.width,h:card.height,viewScale:1,format:"PNG",sourceTags:[],autoTags:[],autoModel:null,rating:{value:effective??"general",from:"public A source; see original inspection"},sourceLinks:detail.sourceLinks.map(url=>({url,from:"public A source"})),coverage:[],split:"validation"});
  }
  const prototypeOrder=[...images].sort((a,b)=>(b.date??"").localeCompare(a.date??"")).map(image=>image.id);
  return {raw:{images,tags:{},hasPredictions:false,skipped:[]},validation:{stablePublicSnapshot:true,exactPrototypeOrder:equal(snapshot.order,prototypeOrder),publicOrder:snapshot.order,prototypeOrder,actualCount:snapshot.total},adaptations:{unknown:unknownAdaptations,tagsAndSearch:"not-compared; full actual inspection retained separately",foldersAndLibraries:"accepted fixed example organization; formal ownership verified separately",rating:"prototype is not an all-known cross-provider rating oracle"}};
}
export const fontObservationScript=`
const done=arguments[arguments.length-1];
const required=[['Kinshoko Inter','400','Aa012'],['Kinshoko Inter','500','Aa012'],['Kinshoko Inter','600','Aa012'],['Kinshoko Han','400','中文'],['Kinshoko Han Punct','500','—…“”']];
document.fonts.ready.then(async()=>{const loads=[];for(const [family,weight,sample] of required){const faces=await document.fonts.load(weight+' 16px "'+family+'"',sample);loads.push({family,weight,sample,faces:faces.map(face=>({family:face.family,weight:face.weight,status:face.status}))});}done({ok:true,loads});}).catch(error=>done({ok:false,error:String(error)}));
`;
function validFonts(observed) {
  return observed?.ok===true&&observed.loads?.length===5&&observed.loads.every(load=>load.faces.length>0&&load.faces.every(face=>{const weights=face.weight.trim().split(/\s+/).map(Number),weight=Number(load.weight);return face.family.replaceAll('"',"")===load.family&&face.status==="loaded"&&weights.length<=2&&weights.every(Number.isFinite)&&(weights.length===1?weights[0]===weight:weights[0]<=weight&&weights[1]>=weight);}));
}
export const wallObservationScript=`
const wall=document.querySelector('.wall'),limit=wall?.getBoundingClientRect(),id=arguments[0];
if(!wall||!limit)return null;
const cards=[...wall.querySelectorAll('.card[data-id]')].map(node=>{const b=node.getBoundingClientRect(),i=node.querySelector('img');return {id:node.dataset.id,box:{x:b.x,y:b.y,width:b.width,height:b.height},decoded:!!i?.complete&&i.naturalWidth>0,complete:b.top>=limit.top+4&&b.bottom<=limit.bottom-4&&b.left>=limit.left&&b.right<=limit.right,original:{width:i?.naturalWidth,height:i?.naturalHeight},fit:i?getComputedStyle(i).objectFit:null};});
const selected=cards.find(card=>card.id===id);
return {viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,userAgent:navigator.userAgent,theme:document.documentElement.dataset.theme??getComputedStyle(document.documentElement).colorScheme,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,density:document.querySelector('.density input')?.value??null,paneOpen:!!document.querySelector('.pane:not([data-collapsed=true])'),viewer:!!document.querySelector('.viewer'),infoOpen:document.querySelector('button[aria-label=信息]')?.getAttribute('aria-pressed')??null,resultCount:document.querySelector('.result-count')?.textContent.trim(),wall:{x:limit.x,y:limit.y,width:wall.clientWidth,height:wall.clientHeight,scrollTop:wall.scrollTop,scrollHeight:wall.scrollHeight,total:wall.dataset.total??null},cards,selected,focusId:document.activeElement?.dataset.id??null,anchorOffset:selected?selected.box.y-limit.y:null,settled:!document.querySelector('.workspace.is-pane-moving')&&!document.getAnimations?.().some(a=>a.playState==='running')};
`;
export const viewerObservationScript=`
const image=document.querySelector('.viewer-stage img,.stage-image'),stage=document.querySelector('.viewer-stage,.stage');
if(!image?.complete||!image.naturalWidth||!stage||getComputedStyle(image).visibility!=='visible'||getComputedStyle(image).display==='none')return null;
if(document.getAnimations?.().some(a=>a.playState==='running'))return null;
const b=image.getBoundingClientRect(),s=stage.getBoundingClientRect();return {natural:{width:image.naturalWidth,height:image.naturalHeight},image:{x:b.x,y:b.y,width:b.width,height:b.height},stage:{x:s.x,y:s.y,width:s.width,height:s.height},dpr:devicePixelRatio,infoOpen:document.querySelector('button[aria-label=信息]')?.getAttribute('aria-pressed')??null,background:stage.dataset.background??[...stage.classList].find(name=>name.startsWith('ground-'))?.slice(7)??null,settled:!document.getAnimations?.().some(a=>a.playState==='running')};
`;
async function fonts(d) {
  const observed=await d.async(fontObservationScript);
  d.assert(validFonts(observed),"all five exact shipped FontFace loads succeed without fallback",observed);
  return observed;
}
async function realWall(d,id) {
  return until("actual wall image decode and settled layout",async()=>{
    const value=await d.exec(wallObservationScript,[id]);
    return value?.settled&&value.cards.length&&value.cards.every(card=>card.decoded)?value:null;
  });
}
async function reveal(d,id) {
  await until("same original content card is completely visible",async()=>{
    await d.exec("const wall=document.querySelector('.wall'),node=[...wall.querySelectorAll('.card')].find(node=>node.dataset.id===arguments[0]);if(node)node.scrollIntoView({block:'center',inline:'nearest'});else wall.scrollTop=wall.scrollHeight;",[id]);
    const value=await realWall(d,id);return value.selected?.complete?value:null;
  });
  return realWall(d,id);
}
async function shot(d,name) {await d.screenshot(name+".png");return fileRecord(join(d.work,name+".png"));}
export async function setExactViewport(d,target) {
  const observations=[];
  for(let index=0;index<12;index++) {
    const now=await d.exec("return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio};");
    if(now.width===target.width&&now.height===target.height)return {viewport:{width:now.width,height:now.height},dpr:now.dpr,observations};
    let outer,desired;
    if(typeof d.nativeResize==="function"){outer=d.nativeResize({width:target.width-now.width,height:target.height-now.height},now.dpr);desired="owned-main-SetWindowPos";}
    else{outer=await d.request("GET",d.session+"/window/rect");desired={width:outer.width+target.width-now.width,height:outer.height+target.height-now.height};await d.request("POST",d.session+"/window/rect",desired);}
    const after=await until("real viewport responds to the actual rectangle request",()=>d.exec("return innerWidth!==arguments[0].width||innerHeight!==arguments[0].height?{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}:null;",[now]));
    observations.push({now,outer,desired,after});
  }
  fail("The exact requested CSS viewport could not be reached; preserve actual adjustment observations: "+JSON.stringify({target,observations}));
}

export async function freezeFormalPrototypePacket(workflow,plan) {
  const d=workflow.d,session=d.session,id=workflow.targetA.contentId,libraryId=workflow.a.id;
  workflow.phase("freeze-same-session-public-prototype-packet");
  const path=join(d.work,"prototype-public-packet.json");
  if(existsSync(path))fail("Retain the prior actual public packet");
  const packet={kind:"spec78-t20-final-public-prototype-packet",capturedAt:new Date().toISOString(),libraryId,checkpoint:"after-fixed-import-owner-before-eagle-reimport",formal:{source:plan.build.source,tree:plan.build.tree,application:plan.application,session,phase:workflow.state.phase},prototype:prototypeCodeRecord(),fixture:fileRecord(join(workflow.fixture.root,"fixture.json")),query:{scope:{kind:"library",libraryId,scope:{kind:"all"}},conditions:{conditions:[]},safeMode:true,thumbnailPx:128,limit:100},pages:[],inspections:{},originals:{},fonts:fontFileRecords(),status:"collecting",nativeComparison:"unverified",humanAcceptance:"unverified"};
  const save=()=>writeFileSync(path,JSON.stringify(packet,null,2));save();
  workflow.state.prototypePacket={path,status:packet.status};workflow.save();
  await d.main();await workflow.current(libraryId);await workflow.scope(libraryId);await workflow.clearSearch();
  if(await d.exec("return document.querySelector('[aria-label=导入参考图]')?.getAttribute('aria-expanded')==='true';"))await workflow.readyClick("//button[@aria-label='导入参考图']");
  d.assert(await d.invoke("safe_mode")===true&&d.session===session,"prototype input comes from the same A/B session with global safe mode on");
  packet.selectedScope=await d.exec("const provider=[...document.querySelectorAll('[data-library-id]')].find(node=>node.dataset.libraryId===arguments[0]);return {rootCurrent:provider?.querySelector('.workspace-provider-root button.sidebar-item')?.getAttribute('aria-current'),conditionCount:document.querySelectorAll('[aria-label=查找条件] button[aria-label=去掉这个条件]').length,search:document.querySelector('input[aria-label=查找参考图]')?.value,current:document.querySelector('select[aria-label=当前资料库]')?.value};",[libraryId]);
  d.assert(packet.selectedScope.rootCurrent==="page"&&packet.selectedScope.conditionCount===0&&packet.selectedScope.search==="","actual controls select the complete A scope with no search conditions",packet.selectedScope);
  let cursor=null;
  do {
    const response=await d.invoke("workspace_browse",{query:{scope:packet.query.scope,conditions:packet.query.conditions,cursor,limit:100,thumbnailPx:128},safeMode:true});
    packet.pages.push({cursor,response});save();cursor=response.nextCursor;
  } while(cursor!==null);
  const snapshot=validatePublicPages(packet.pages,libraryId),inputs=fixtureInputIndex(workflow.fixture);
  for(const card of snapshot.cards) {
    const source=card.sources.find(item=>item.libraryId===libraryId&&item.matches&&!item.deleted&&item.unavailable===null);
    const target={libraryId,imageId:source.imageId,contentId:card.id},value=await workflow.inspect(target,true),original=inputs.get(card.id);
    if(!original)fail("No exact this-round original maps to the public card: "+card.id);
    packet.inspections[card.id]={target,value};packet.originals[card.id]=original;
  }
  const adapter=adaptPublicPacket(packet);packet.order=snapshot.order;packet.validation={...adapter.validation,exactBytes:true,exactDimensions:true};packet.adaptations=adapter.adaptations;
  packet.environment=await d.exec("return {viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,userAgent:navigator.userAgent,theme:document.documentElement.dataset.theme??getComputedStyle(document.documentElement).colorScheme,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};");
  packet.fontLoads=await fonts(d);
  const baseline={clickedContentId:id,tasks:{},sameSession:session,viewport:packet.environment};
  if(!snapshot.order.includes(id))fail("The comparison original must occur in this complete actual A public packet");
  await d.exec("document.querySelector('input[aria-label=查找参考图]').focus({preventScroll:true});document.querySelector('.wall').scrollTop=0;");
  baseline.initial=await until("actual formal result count catches up to this complete A packet",async()=>{const value=await realWall(d,id);return value.resultCount===snapshot.total+" 张"?value:null;});
  d.assert(baseline.initial.resultCount===snapshot.total+" 张","formal result count equals this round's full public packet",baseline.initial);
  baseline.tasks.initial={observation:baseline.initial,screenshot:await shot(d,"prototype-formal-wall")};
  baseline.reading=await reveal(d,id);
  await workflow.readyClick("//*[@role='option' and @data-id="+literal(id)+"]");
  await workflow.readyClick("//*[@aria-label='原图查看器']//button[normalize-space()='适应窗口']");
  baseline.tasks.viewer={observation:await until("formal fitted viewer painted",()=>d.exec(viewerObservationScript)),screenshot:await shot(d,"prototype-formal-viewer")};
  await d.key("\uE00C");
  await until("formal single click return focus",()=>d.exec("return !document.querySelector('.viewer')&&document.activeElement?.dataset.id===arguments[0];",[id]));
  baseline.tasks.singleClickReturn=await realWall(d,id);
  await reveal(d,id);await d.exec("document.querySelector('.card[data-id=\"'+arguments[0]+'\"]').focus({preventScroll:true});",[id]);await d.key("\uE007");
  await until("formal keyboard viewer painted",()=>d.exec(viewerObservationScript));await d.key("\uE00C");
  await until("formal Enter Escape returns same visible card",()=>d.exec("return !document.querySelector('.viewer')&&document.activeElement?.dataset.id===arguments[0];",[id]));
  baseline.tasks.keyboardReturn=await realWall(d,id);
  await workflow.readyClick("//button[@aria-label='收起侧栏']");
  baseline.tasks.collapse=await until("formal actual sidebar width change",async()=>{const value=await realWall(d,id);return !value.paneOpen&&value.wall.width!==baseline.reading.wall.width?value:null;});
  baseline.tasks.collapseScreenshot=await shot(d,"prototype-formal-collapsed");
  await workflow.readyClick("//button[@aria-label='展开侧栏']");
  baseline.tasks.expand=await until("formal actual sidebar width restored",async()=>{const value=await realWall(d,id);return value.paneOpen&&value.wall.width===baseline.reading.wall.width?value:null;});
  baseline.tasks.resize=[];
  const initialViewport=baseline.initial.viewport;
  for(const requested of [{width:Math.max(640,initialViewport.width-230),height:initialViewport.height},initialViewport]) {
    const actual=await setExactViewport(d,requested);
    const observation=await realWall(d,id);
    baseline.tasks.resize.push({requested,actual,observation});
  }
  const latest=await d.invoke("workspace_browse",{query:{scope:packet.query.scope,conditions:packet.query.conditions,cursor:null,limit:100,thumbnailPx:128},safeMode:true});
  d.assert(latest.status.revision===snapshot.revision&&latest.total===snapshot.total&&equal(latest.cards.map(card=>card.id),packet.pages[0].response.cards.map(card=>card.id))&&d.session===session,"layout-only comparison tasks preserve this actual public snapshot",{revision:snapshot.revision,latest});
  packet.baseline=baseline;packet.status=adapter.validation.exactPrototypeOrder?"frozen-public-input":"frozen-public-input-prototype-order-incompatible";
  packet.nativeComparison="formal baseline captured; accepted prototype browser unverified";
  save();workflow.state.prototypePacket={file:fileRecord(path),status:packet.status,actualCount:snapshot.total,exactPrototypeOrder:adapter.validation.exactPrototypeOrder};workflow.save();
  return workflow.state.prototypePacket;
}

// Fresh accepted-code mirror avoids any mutation of the historical .local directory or profile.
// Creates files only. Vite/browser/driver startup remains a separately granted root stage.
export function preparePrototypeInput(packetPath,output) {
  const root=ownedWork(output);
  if(existsSync(root))fail("Use a new prototype input directory");
  const packet=readJson(packetPath),adapter=adaptPublicPacket(packet);
  if(packet.kind!=="spec78-t20-final-public-prototype-packet"||packet.status!=="frozen-public-input"||!adapter.validation.exactPrototypeOrder||!equal(packet.order,adapter.validation.publicOrder)||packet.validation?.exactBytes!==true||packet.validation?.exactDimensions!==true)fail("A complete actual formal packet with exact prototype order is required");
  if(!validFonts(packet.fontLoads)||packet.baseline?.sameSession!==packet.formal.session)fail("Actual same-session formal baseline/fonts must accompany the packet");
  const source=sourceRecord(),code=prototypeCodeRecord(),fonts=fontFileRecords(),localBefore=localInventory();
  if(!equal(code,packet.prototype)||!equal(fonts,packet.fonts))fail("The accepted code/fonts changed after formal packet capture");
  const mirror=join(root,"accepted-prototype"),local=join(mirror,".local");mkdirSync(local,{recursive:true});
  for(const [name,record] of Object.entries(code.files)){const destination=join(mirror,name);mkdirSync(dirname(destination),{recursive:true});copyFileSync(verifiedFile(record,"Accepted prototype code").path,destination,constants.COPYFILE_EXCL);verifiedFile({...record,path:destination},"Fresh accepted code copy");}
  mkdirSync(join(local,"media"));mkdirSync(join(local,"fonts"));
  const originals={};
  for(const id of packet.order) {
    const record=verifiedFile(packet.originals[id],"This-round public original"),size=pngDimensions(record.path);
    if(record.sha256!==id||!equal(size,{width:packet.originals[id].width,height:packet.originals[id].height}))fail("Public original identity/dimensions changed before fresh input preparation");
    const destination=join(local,"media",id+".png");copyFileSync(record.path,destination,constants.COPYFILE_EXCL);
    originals[id]={source:record,fresh:verifiedFile({...record,path:destination},"Fresh exact PNG copy"),...size};
  }
  for(const font of fonts){const destination=join(local,"fonts",font.prototype);copyFileSync(font.path,destination,constants.COPYFILE_EXCL);verifiedFile({...font,path:destination},"Fresh exact font copy");}
  writeNew(join(local,"library.json"),adapter.raw);
  // The original config imports Vite by package name. Bind the actual existing offline
  // prototype dependencies to this owned mirror, rather than changing its config.
  const dependencies=join(prototypeRoot,"node_modules");
  if(!existsSync(join(dependencies,"vite","package.json")))fail("The accepted mirror needs actual offline prototype Vite dependencies");
  symlinkSync(dependencies,join(mirror,"node_modules"),"junction");
  const localAfter=localInventory();
  if(!equal(localBefore,localAfter))fail("The historical prototype .local changed during preparation");
  const manifest={kind:"spec78-t20-prototype-input",status:"prepared-not-run",at:new Date().toISOString(),source,packet:fileRecord(packetPath),formal:packet.formal,acceptedSource:ACCEPTED_PROTOTYPE,code,mirror,local:localInventory(local),historicalLocalBefore:localBefore,historicalLocalAfter:localAfter,dependencies:{path:dependencies,vitePackage:fileRecord(join(dependencies,"vite","package.json")),viteCli:fileRecord(join(dependencies,"vite","bin","vite.js"))},fonts,originals,validation:adapter.validation,adaptations:adapter.adaptations,browserProfile:join(root,"fresh-browser-profile"),prototypeExecuted:false,fullT20Acceptance:false};
  writeNew(join(root,"prototype-input.json"),manifest);return manifest;
}

// d is a root-granted, separately owned fresh browser session. This module never launches
// a browser/server, reuses an existing human profile, or imports the old top-level runners.
export async function compareAcceptedPrototype(d,inputPath,rootGrant) {
  if(!rootGrant?.trim())fail("An exact root browser grant is required");
  const input=readJson(inputPath),packet=readJson(input.packet.path);
  verifiedFile(input.packet,"Actual formal packet");
  if(input.kind!=="spec78-t20-prototype-input"||input.status!=="prepared-not-run"||input.acceptedSource!==ACCEPTED_PROTOTYPE||!input.validation.exactPrototypeOrder)fail("Expected fresh accepted input and real public order");
  if(!equal(input.local,localInventory(join(input.mirror,".local")))||!equal(input.historicalLocalBefore,localInventory()))fail("Fresh or historical prototype inputs changed before browser comparison");
  const report={kind:"spec78-t20-accepted-prototype-comparison",status:"running",at:new Date().toISOString(),rootGrant,input:fileRecord(inputPath),formal:packet.formal,browserSession:d.session,actualCount:packet.order.length,tasks:{},intentionalBoundaries:input.adaptations,humanAcceptance:"unverified",fullT20Acceptance:false};
  const path=join(d.work,"prototype-comparison.json");if(existsSync(path))fail("Preserve the prior prototype comparison");const save=()=>writeFileSync(path,JSON.stringify(report,null,2));save();
  const id=packet.baseline.clickedContentId,target=packet.environment.viewport;
  try {
    report.viewportAdjustments=await setExactViewport(d,target);
    report.environment=await d.exec("return {viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,userAgent:navigator.userAgent,theme:document.documentElement.dataset.theme??getComputedStyle(document.documentElement).colorScheme,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};");
    d.assert(equal(report.environment.viewport,target)&&report.environment.dpr===packet.environment.dpr&&report.environment.theme===packet.environment.theme&&report.environment.reducedMotion===packet.environment.reducedMotion,"accepted prototype and formal baseline use the exact CSS viewport, DPR, theme and motion setting",{formal:packet.environment,prototype:report.environment});
    report.fonts=await fonts(d);
    report.initial=await realWall(d,id);
    d.assert(report.initial.resultCount===packet.order.length+" 张"&&report.initial.density===packet.baseline.initial.density&&report.initial.paneOpen===packet.baseline.initial.paneOpen,"fresh prototype count, density and sidebar match the actual complete formal packet",report.initial);
    d.assert(report.initial.cards.every(card=>packet.order.includes(card.id)&&card.fit==="contain"),"fresh prototype mounted content identities and complete composition come from this exact packet",report.initial.cards);
    report.tasks.initial={observation:report.initial,screenshot:await shot(d,"prototype-accepted-wall")};
    report.reading=await reveal(d,id);
    await d.enabled("//*[@role='listitem' and @data-id="+literal(id)+"]");await d.click("//*[@role='listitem' and @data-id="+literal(id)+"]");
    if(await d.exec("return document.querySelector('button[aria-label=信息]')?.getAttribute('aria-pressed')==='true';")){await d.enabled("//button[@aria-label='信息']");await d.click("//button[@aria-label='信息']");}
    const formalGround=packet.baseline.tasks.viewer.observation.background,groundLabel={dark:"深灰",mid:"中灰",light:"浅灰",checker:"棋盘"}[formalGround];
    if(!groundLabel)fail("Preserve the actual formal viewer background");
    await d.enabled("//button[@title="+literal("背景："+groundLabel)+"]");await d.click("//button[@title="+literal("背景："+groundLabel)+"]");
    await d.enabled("//button[normalize-space()='适应']");await d.click("//button[normalize-space()='适应']");
    const image=await until("accepted same original fitted viewer painted",()=>d.exec(viewerObservationScript)),original=packet.originals[id];
    d.assert(image.natural.width===original.width&&image.natural.height===original.height,"accepted viewer displays the same exact original dimensions",image);
    report.tasks.viewer={observation:image,screenshot:await shot(d,"prototype-accepted-viewer")};
    await d.key("\uE00C");await until("accepted single click returns same card focus",()=>d.exec("return !document.querySelector('.viewer')&&document.activeElement?.dataset.id===arguments[0];",[id]));
    report.tasks.singleClickReturn=await realWall(d,id);
    await reveal(d,id);await d.exec("document.querySelector('.card[data-id=\"'+arguments[0]+'\"]').focus({preventScroll:true});",[id]);await d.key("\uE007");
    await until("accepted keyboard viewer decoded",()=>d.exec(viewerObservationScript));await d.key("\uE00C");
    await until("accepted Enter Escape returns same card",()=>d.exec("return !document.querySelector('.viewer')&&document.activeElement?.dataset.id===arguments[0];",[id]));report.tasks.keyboardReturn=await realWall(d,id);
    await d.enabled("//button[@aria-label='收起侧栏']");await d.click("//button[@aria-label='收起侧栏']");
    report.tasks.collapse=await until("accepted real sidebar collapse",async()=>{const value=await realWall(d,id);return !value.paneOpen&&value.wall.width!==report.reading.wall.width?value:null;});report.tasks.collapseScreenshot=await shot(d,"prototype-accepted-collapsed");
    await d.enabled("//button[@aria-label='展开侧栏']");await d.click("//button[@aria-label='展开侧栏']");
    report.tasks.expand=await until("accepted real sidebar expand",async()=>{const value=await realWall(d,id);return value.paneOpen&&value.wall.width===report.reading.wall.width?value:null;});
    report.tasks.resize=[];
    for(const formal of packet.baseline.tasks.resize) {
      const actual=await setExactViewport(d,formal.actual.viewport),observation=await realWall(d,id);
      report.tasks.resize.push({formal,actual,observation});
    }
    report.actualAnchorDifferences=Object.fromEntries(["singleClickReturn","keyboardReturn","collapse","expand"].map(task=>[task,{formal:packet.baseline.tasks[task].anchorOffset,prototype:report.tasks[task].anchorOffset,formalScroll:packet.baseline.tasks[task].wall.scrollTop,prototypeScroll:report.tasks[task].wall.scrollTop}]));
    if(!equal(input.historicalLocalBefore,localInventory()))fail("The historical .local must remain unchanged");
    report.status="observed-same-input-baseline-tasks";report.prototypeExecuted=true;
    report.unverified=["reference-sidebar visual review","human visual acceptance","physical monitor and input devices","Windows 10"];
    return report;
  }catch(error){report.status="failed";report.error=String(error);throw error;}
  finally{report.finishedAt=new Date().toISOString();save();}
}
export async function main(args=process.argv.slice(2)) {
  if(args[0]==="--prepare-input"&&args.length===3)return preparePrototypeInput(args[1],args[2]);
  fail("node e2e/spec78-combination-prototype.mjs --prepare-input <actual-packet.json> <new-owned-directory>");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{console.log(JSON.stringify(await main()));}catch(error){console.error(error);process.exitCode=1;}
}
