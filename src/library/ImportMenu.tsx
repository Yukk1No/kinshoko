import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ImportBar, type ImportActions } from "./ImportBar";
import { ImportSplit } from "../ui/ImportSplit";
import type { ImportReport } from "../bindings/ImportReport";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { dismissImport, importTasks, isCursorExpired, onSafeModeSetting, onWorkspaceChanged } from "../ipc";
import { destinationAvailable, folderChoices, SaveDestinationPicker, useSaveDestination } from "./SaveDestination";

// A mode/workspace event can arrive before a fresh backend receipt. Keep retry failures,
// but remove every successful category together until the new context is projected.
function concealSuccesses(report: ImportReport): ImportReport {
 return {...report,privateSummary:true,eagleMissing:0,
  trashDuplicates:report.trashDuplicates||report.items.some(item=>item.outcome.kind==="trashDuplicate"),
  items:report.items.filter(item=>["readFailed","unsupported","skippedDeleted"].includes(item.outcome.kind))};
}

/**
 * 顶栏的导入分体按钮（#98）：左半直接选图片文件，箭头里选文件夹或 Eagle；选好后在对话框里确认图库和文件夹，
 * 进度与结果回执是右下角的卡片。任务回执跨浏览与当前图库的变化保留。
 */
export function ImportMenu(p:ComponentProps<typeof ImportBar>&{scope?:WorkspaceScope}) {
 const [tasks,setTasks]=useState<ImportTaskSnapshot[]>([]),[selectedTask,setSelectedTask]=useState<string|null>(null),[problem,setProblem]=useState<string|null>(null);
 const context=useSaveDestination();
 const actions=useRef<ImportActions>(null);
 const [busy,setBusy]=useState({busy:false,eagle:false});
 const onBusyChange=useCallback((busy:boolean,eagle:boolean)=>setBusy(previous=>previous.busy===busy&&previous.eagle===eagle?previous:{busy,eagle}),[]);
 const optimistic=useRef(new Map<string,ImportTaskSnapshot>());
 const dismissed=useRef(new Set<string>());
 useEffect(()=>{
  let alive=true,epoch=0,timer:ReturnType<typeof setTimeout>;
  const invalidate=()=>{epoch++;setTasks(previous=>previous.map(task=>({...task,progress:task.report?{done:0,total:0}:task.progress,report:task.report?concealSuccesses(task.report):null})));};
  const safe=onSafeModeSetting(invalidate),workspace=onWorkspaceChanged(invalidate);
  // 读取期间修订变了只是过时，下一次轮询（400 ms）重读，不显示成问题（#98 本机 r16）。
 const refresh=()=>{const expected=epoch;void importTasks().then(value=>{if(alive&&expected===epoch&&Array.isArray(value)){for(const t of value)optimistic.current.delete(t.taskId);setTasks([...value,...optimistic.current.values()].filter(t=>!dismissed.current.has(t.taskId)));}},error=>{if(alive&&expected===epoch&&!isCursorExpired(error))setProblem(String(error));}).finally(()=>{if(alive)timer=setTimeout(refresh,400);});};
  refresh();return()=>{alive=false;clearTimeout(timer);void safe.then(stop=>stop());void workspace.then(stop=>stop());};
 },[]);
 const selected=tasks.find(t=>t.taskId===selectedTask)??tasks.find(t=>t.report===null)??tasks.at(-1);
 const task=selected?{...selected,report:selected.report??(p.finished?.taskId===selected.taskId?concealSuccesses(p.finished.report):null),
   progress:p.running?.taskId===selected.taskId?p.running.progress:selected.progress}:undefined;
 // 主窗口只收当前图库的导入事件：导入到别的图库时它记下的“进行中”不会结束。已关闭的回执不再借它复活（#98 本机 r14）。
 const fallbackRunning=p.running&&!(p.running.taskId&&dismissed.current.has(p.running.taskId))?p.running:null;
 const running=task&&(task.report===null||task.finishing)?{taskId:task.taskId,progress:task.progress,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName}:task?null:fallbackRunning;
 const finished=task?.report&&!task.finishing?{taskId:task.taskId,report:task.report,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName}:task?null:p.finished?{...p.finished,report:concealSuccesses(p.finished.report)}:null;
 const active=running!==null;
 const library=context.providers.find(provider=>provider.registration.library.id===context.destination?.libraryId)?.registration.library;
 // 在文件夹里浏览时，导入默认放进这个文件夹（与原来的导入按钮相同）。
 const prefill=()=>{if(p.scope?.kind==="library"&&(p.scope.scope.kind==="folder"||p.scope.scope.kind==="folderTree"))context.setDestination({libraryId:p.scope.libraryId,folderId:p.scope.scope.id});};
 const via=(action:"files"|"folder")=>()=>{prefill();actions.current?.[action]();};
 const notes=<>
  {problem&&<p className="k-task-sub is-danger" role="alert">{problem}</p>}
  {task?.report&&task.finishing&&<p className="k-task-sub" role="status">已导入，正在把标签定义存进图库…</p>}
  {task?.warnings.map((warning,index)=><p className="k-task-sub is-warn" role="alert" key={index}>{warning}</p>)}
 </>;
 const switcher=tasks.length>1?<label className="k-task-switch">查看导入任务<select className="k-select" aria-label="查看导入任务" value={task?.taskId??""} onChange={e=>setSelectedTask(e.target.value)}>
  {tasks.map(t=><option key={t.taskId} value={t.taskId}>{t.libraryName} / {t.folderName} · {t.report?"已结束":"进行中"}</option>)}</select></label>:null;
 return <div className="import-menu">
  <ImportSplit busy={busy.busy||active} eagleBusy={busy.eagle} onFiles={via("files")} onFolder={via("folder")} onEagle={()=>{prefill();actions.current?.eagle();}}
   onShowTasks={tasks.length>0||active||finished?()=>actions.current?.showTasks():undefined}/>
  <ImportBar {...p} actionsRef={actions} onBusyChange={onBusyChange} previewContextKey={p.libraryId} libraryId={context.destination?.libraryId??""} libraryName={library?.name??"尚未选择的图库"}
    destination={context.destination} destinationReady={context.ready&&destinationAvailable(context.destination,context.providers)} running={running} finished={finished}
    picker={<SaveDestinationPicker value={context.destination} onChange={context.setDestination} labelPrefix="放到"/>}
    taskSwitcher={switcher} cardNotes={notes} ownerLabel={task?`${task.libraryName} / ${task.folderName}`:null}
    onStarted={(id,fixed)=>{
      if(fixed){
        const provider=context.providers.find(p=>p.registration.library.id===fixed.libraryId);
        optimistic.current.set(id,{taskId:id,destination:fixed,libraryName:provider?.registration.library.name??fixed.libraryId,
          folderName:fixed.folderId===null?"未归类":folderChoices(provider?.sidebar?.folders??[]).find(f=>f.id===fixed.folderId)?.path??"目标文件夹不可用",progress:{done:0,total:0},report:null,finishing:false,warnings:[]});
        setTasks(previous=>previous.some(t=>t.taskId===id)?previous:[...previous,optimistic.current.get(id)!]);
      }
      setSelectedTask(id);p.onStarted(id,fixed);
    }} onRetryDestination={context.setDestination} onDismissReport={()=>{
      if(task?.report){
        optimistic.current.delete(task.taskId);dismissed.current.add(task.taskId);
        setTasks(previous=>previous.filter(t=>t.taskId!==task.taskId));
        void dismissImport(task.destination.libraryId,task.taskId).catch(error=>{dismissed.current.delete(task.taskId);setProblem(String(error));});
      }
      p.onDismissReport();
    }}/>
 </div>;
}
