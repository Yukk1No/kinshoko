import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ImportBar } from "./ImportBar";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { dismissImport, importTasks } from "../ipc";
import { destinationAvailable, folderChoices, SaveDestinationPicker, useSaveDestination } from "./SaveDestination";

/** Compact accepted-prototype entry; task receipts stay mounted across browse/current changes. */
export function ImportMenu(p:ComponentProps<typeof ImportBar>&{scope?:WorkspaceScope}) {
 const [open,setOpen]=useState(false),[tasks,setTasks]=useState<ImportTaskSnapshot[]>([]),[selectedTask,setSelectedTask]=useState<string|null>(null),[problem,setProblem]=useState<string|null>(null);
 const menu=useRef<HTMLDivElement>(null),context=useSaveDestination();
 const optimistic=useRef(new Map<string,ImportTaskSnapshot>());
 const dismissed=useRef(new Set<string>());
 const show=useCallback(()=>setOpen(true),[]);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>;
  const refresh=()=>void importTasks().then(value=>{if(alive&&Array.isArray(value)){for(const t of value)optimistic.current.delete(t.taskId);setTasks([...value,...optimistic.current.values()].filter(t=>!dismissed.current.has(t.taskId)));}},error=>{if(alive)setProblem(String(error));}).finally(()=>{if(alive)timer=setTimeout(refresh,400);});
  refresh();return()=>{alive=false;clearTimeout(timer);};
 },[]);
 const selected=tasks.find(t=>t.taskId===selectedTask)??tasks.find(t=>t.report===null)??tasks.at(-1);
 const task=selected?{...selected,report:selected.report??(p.finished?.taskId===selected.taskId?p.finished.report:null),
   progress:p.running?.taskId===selected.taskId?p.running.progress:selected.progress}:undefined;
 const running=task&&(task.report===null||task.finishing)?{taskId:task.taskId,progress:task.progress,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName}:task?null:p.running;
 const finished=task?.report&&!task.finishing?{taskId:task.taskId,report:task.report,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName}:task?null:p.finished;
 const active=running!==null;
 useEffect(()=>{if(active||finished)show();},[active,finished?.taskId,show]);
 useEffect(()=>{
  if(!open)return;
  const outside=(e:PointerEvent)=>{if(!menu.current?.contains(e.target as Node))setOpen(false);};
  const esc=(e:KeyboardEvent)=>{if(e.key==="Escape")setOpen(false);};
  window.addEventListener("pointerdown",outside);window.addEventListener("keydown",esc);
  return()=>{window.removeEventListener("pointerdown",outside);window.removeEventListener("keydown",esc);};
 },[open]);
 const library=context.providers.find(provider=>provider.registration.library.id===context.destination?.libraryId)?.registration.library;
 return <div className="import-menu" ref={menu}>
  <button type="button" aria-label="导入参考图" aria-expanded={open} title="导入文件、文件夹或 Eagle 资料库" onClick={()=>{
    if(!open&&p.scope?.kind==="library"&&(p.scope.scope.kind==="folder"||p.scope.scope.kind==="folderTree"))context.setDestination({libraryId:p.scope.libraryId,folderId:p.scope.scope.id});
    setOpen(!open);
  }}>导入{active?"…":""}</button>
  <div className="import-popup" hidden={!open}>
   <header><strong>导入参考图</strong><button type="button" aria-label="关闭导入操作" onClick={()=>setOpen(false)}>×</button></header>
   <SaveDestinationPicker value={context.destination} onChange={context.setDestination}/>
   {problem&&<p role="alert">{problem}</p>}
   {tasks.length>1&&<label>查看导入任务<select aria-label="查看导入任务" value={task?.taskId??""} onChange={e=>setSelectedTask(e.target.value)}>{tasks.map(t=><option key={t.taskId} value={t.taskId}>{t.libraryName} / {t.folderName} · {t.report?"已结束":"进行中"}</option>)}</select></label>}
   <ImportBar {...p} libraryId={context.destination?.libraryId??""} libraryName={library?.name??"尚未选择"}
    destination={context.destination} destinationReady={context.ready&&destinationAvailable(context.destination,context.providers)} running={running} finished={finished}
    onStarted={(id,fixed)=>{
      if(fixed){
        const provider=context.providers.find(p=>p.registration.library.id===fixed.libraryId);
        optimistic.current.set(id,{taskId:id,destination:fixed,libraryName:provider?.registration.library.name??fixed.libraryId,
          folderName:fixed.folderId===null?"未归类":folderChoices(provider?.sidebar?.folders??[]).find(f=>f.id===fixed.folderId)?.path??"目标文件夹不可用",progress:{done:0,total:0},report:null,finishing:false,warnings:[]});
        setTasks(previous=>previous.some(t=>t.taskId===id)?previous:[...previous,optimistic.current.get(id)!]);
      }
      setSelectedTask(id);p.onStarted(id,fixed);
    }} onRetryDestination={context.setDestination} onShowRequested={show} onDismissReport={()=>{
      if(task?.report){
        optimistic.current.delete(task.taskId);dismissed.current.add(task.taskId);
        setTasks(previous=>previous.filter(t=>t.taskId!==task.taskId));
        void dismissImport(task.destination.libraryId,task.taskId).catch(error=>{dismissed.current.delete(task.taskId);setProblem(String(error));setOpen(true);});
      }
      p.onDismissReport();setOpen(false);
    }}/>
   {task?.report&&task.finishing&&<p role="status">内容已处理，正在发布此资料库的标签定义…</p>}
   {task?.warnings.map((warning,index)=><p role="alert" key={index}>{warning}</p>)}
   {task&&<p className="import-owner" role="status">任务保存位置：{task.libraryName} / {task.folderName}</p>}
   <p className="selection-hint">单击查看 · Ctrl／Shift 多选 · 空格选择</p>
  </div>
 </div>;
}
