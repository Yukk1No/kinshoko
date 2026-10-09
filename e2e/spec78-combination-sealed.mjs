// Receipt streaming uses the already exercised public Channel protocol from T15.
// This module is import-safe. It reuses a pure revocation predicate, never a previous result.
import { join } from "node:path";
import { until } from "./spec78-combination-driver.mjs";
import { transferWasRevokedBeforeCompletion } from "../scripts/check-sealed-preview-revocation.mjs";

function receiptRead(args, onFirstChunk, actionReturnedAt) {
  return new Promise(resolve => {
    const ipc = window.__TAURI_INTERNALS__, startedAt = performance.now();
    let length = 0, chunks = 0, maximumChunkBytes = 0, firstChunkAt = null, lastChunkAt = null, completionMarkerAt = null, channelEndedAt = null, acknowledgedAt = null, rejectedAt = null, chunksAfterActionResponse = 0, bytesAfterActionResponse = 0, acknowledged = false, failure = null, settled = false;
    const stats = () => ({ length, chunks, maximumChunkBytes, startedAt, firstChunkAt, lastChunkAt, completionMarkerAt, channelEndedAt, acknowledgedAt, rejectedAt, chunksAfterActionResponse, bytesAfterActionResponse, endedAt: performance.now(), elapsedMs: performance.now() - startedAt });
    const finish = () => {
      if (settled || channelEndedAt === null) return;
      if (failure !== null) { settled = true; resolve({ ...stats(), failure }); }
      else if (completionMarkerAt !== null && acknowledged) { settled = true; resolve(stats()); }
    };
    const callback = ipc.transformCallback(raw => {
      if (raw.end) { channelEndedAt = performance.now(); ipc.unregisterCallback(callback); finish(); return; }
      const count = raw.message.byteLength ?? raw.message.length;
      if (count === 0) completionMarkerAt = performance.now();
      else {
        length += count; chunks++; maximumChunkBytes = Math.max(maximumChunkBytes, count); lastChunkAt = performance.now();
        if (actionReturnedAt?.() != null) { chunksAfterActionResponse++; bytesAfterActionResponse += count; }
        if (firstChunkAt === null) { firstChunkAt = lastChunkAt; onFirstChunk?.(); }
      }
      finish();
    });
    ipc.invoke('plugin:library|read_import_preview', { ...args, onChunk: '__CHANNEL__:' + callback }).then(() => { acknowledged = true; acknowledgedAt = performance.now(); finish(); }, error => { rejectedAt = performance.now(); failure = String(error); finish(); });
  });
}
async function bytes(d,preview,itemId=preview.items[0],targetPx=2400) {
  const result=await d.async(`const done=arguments[arguments.length-1];(${receiptRead})(arguments[0]).then(done);`,[{sessionId:preview.id,itemId,targetPx}]);
  d.record("receipt-byte-read",{sessionId:preview.id,itemId,targetPx,result});return result;
}
async function race(d,preview,action,afterFirstChunk=true,targetPx=2400) {
  const result=await d.async(`const done=arguments[arguments.length-1],args=arguments[0],action=arguments[1],afterFirst=arguments[2],readPreview=${receiptRead};let ended=false,actionPromise,actionStartedAt,pendingAtAction,actionReturnedAt=null;const act=()=>{if(actionPromise)return;pendingAtAction=!ended;actionStartedAt=performance.now();actionPromise=window.__TAURI_INTERNALS__.invoke(action.command,action.args).then(value=>{actionReturnedAt=performance.now();return {value,actionEndedAt:actionReturnedAt};},error=>{actionReturnedAt=performance.now();return {actionFailure:String(error),actionEndedAt:actionReturnedAt};});};const read=readPreview(args,afterFirst?act:undefined,()=>actionReturnedAt).then(value=>{ended=true;return value;});if(!afterFirst)Promise.resolve().then(act);read.then(async value=>{if(!actionPromise)act();done({...value,pendingAtAction,actionStartedAt,...await actionPromise});});`,[{sessionId:preview.id,itemId:preview.items[0],targetPx},action,afterFirstChunk]);
  const value={action,afterFirstChunk,targetPx,...result};d.record("receipt-revocation-race",value);return value;
}
function assertReturnedRevocationBoundary(d,result,label) {
  d.assert(Number.isFinite(result.actionEndedAt)&&!result.actionFailure&&result.chunksAfterActionResponse===0&&result.bytesAfterActionResponse===0,label+" publishes zero content chunks or bytes after successful revocation returns",result);
}
export async function sealedTransferBoundaries(workflow) {
  workflow.phase("same-receipt-real-stream-revocation");const d=workflow.d,receipt=workflow.sealedReceipt,races=[];
  const explicit=()=>d.invoke("open_import_preview",{libraryId:workflow.a.id,taskId:receipt.taskId});
  const preview=await explicit();d.assert(preview.items.length===1,"backend consent derives only this real task's sealed duplicate",preview);
  const complete=await bytes(d,preview);
  d.assert(!complete.failure&&complete.length>10000000&&complete.chunks>100&&complete.maximumChunkBytes<1024&&complete.completionMarkerAt!==null,"actual large receipt original completes through bounded public Channel chunks",complete);
  d.assert(Boolean((await bytes(d,preview,workflow.targetA.imageId)).failure),"an ordinary image ID cannot impersonate a receipt capability");
  const close=await race(d,preview,{command:"plugin:library|close_import_preview",args:{sessionId:preview.id}});races.push(close);
  d.assert(transferWasRevokedBeforeCompletion(close,complete.length),"first actual chunk followed by close prevents complete sealed image publication",close);
  assertReturnedRevocationBoundary(d,close,"Closing the receipt");
  d.assert(Boolean((await bytes(d,preview)).failure),"the closed receipt capability remains revoked");
  const modePreview=await explicit();const mode=await race(d,modePreview,{command:"plugin:library|set_safe_mode",args:{on:true}});races.push(mode);
  d.assert(transferWasRevokedBeforeCompletion(mode,complete.length),"a same-on safe-mode transition interrupts an actually partial sealed stream",mode);
  assertReturnedRevocationBoundary(d,mode,"A same-on mode transition");
  d.assert(await d.invoke("safe_mode")===true,"same-on revocation keeps global safety enabled");
  const settingsPath=join(d.work,"same-mode-revocation.kinshoko-settings");await d.invoke("export_application_settings",{path:settingsPath});
  const settings=await d.invoke("preview_application_settings",{path:settingsPath}),settingsPreview=await explicit();
  const replacement=await race(d,settingsPreview,{command:"plugin:library|restore_application_settings",args:{path:settingsPath,fingerprint:settings.fingerprint}});races.push(replacement);
  d.assert(transferWasRevokedBeforeCompletion(replacement,complete.length),"same-safe-mode program replacement revokes an actually partial receipt stream",replacement);
  assertReturnedRevocationBoundary(d,replacement,"Program settings replacement");
  const currentPreview=await explicit();
  const current=await race(d,currentPreview,{command:"plugin:library|switch_library",args:{libraryId:workflow.b.id}},false,640);races.push(current);
  d.assert(current.pendingAtAction&&current.failure&&current.length===0&&!current.actionFailure,"current-provider change rejects the genuinely pending receipt read before content publication",current);
  assertReturnedRevocationBoundary(d,current,"Changing current provider");
  await workflow.current(workflow.b.id);await workflow.current(workflow.a.id);
  d.assert((await workflow.task(receipt.taskId)).destination.libraryId===workflow.a.id,"context changes keep the earlier receipt's submitted owner");
  d.assert(!await d.exec("return !!document.querySelector('dialog.sealed-import-preview img');"),"revoked UI content stays veiled throughout subsequent real transfer completions");
  workflow.state.sealed.transfers={complete,races};workflow.save();
  await d.screenshot("08-sealed-stream-revoked.png");
}
