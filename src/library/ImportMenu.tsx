import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type Ref } from "react";
import { ImportBar, type ImportActions } from "./ImportBar";
import { ImportButton } from "../ui/ImportButton";
import type { ImportReport } from "../bindings/ImportReport";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { dismissImport, importTasks, isCursorExpired, onSafeModeSetting, onWorkspaceChanged, stageClipboardImport } from "../ipc";
import { destinationAvailable, folderChoices, SaveDestinationPicker, useSaveDestination } from "./SaveDestination";
import { importPrefill } from "./savePrefill";
import type { SaveDestination } from "../bindings/SaveDestination";
import { Select } from "../ui/Select";
import { WarnIcon } from "../ui/WarnIcon";
import { useTranslation } from "react-i18next";
import { describeCommandError, errorText } from "../ipc/commandError";

const POLL_MIN=400,POLL_MAX=3200;

// A mode/workspace event can arrive before a fresh backend receipt. Keep retry failures,
// but remove every successful category together until the new context is projected.
function concealSuccesses(report: ImportReport): ImportReport {
 return {...report,privateSummary:true,eagleMissing:0,
  trashDuplicates:report.trashDuplicates||report.items.some(item=>item.outcome.kind==="trashDuplicate"),
  items:report.items.filter(item=>["readFailed","unsupported","skippedDeleted"].includes(item.outcome.kind))};
}

/**
 * 顶栏的导入分体按钮（#98）：左半直接选图片文件，箭头里选文件夹或 Eagle；选好后在对话框里确认图库和文件夹，
 * 进度与结果回执是右下角的卡片。任务回执带着自己的保存目标，跨浏览范围的变化保留。
 */
/**
 * 从别处（图片墙右键菜单）开始导入的入口。clipboard：把剪贴板里的图片暂存成文件，再走同一导入流程
 * （保存位置照常选择）；剪贴板没有图片或正在导入时 reject 中文原因（#105）。
 */
export type ImportControl = { files: () => void; folder: () => void; eagle: () => void; clipboard: () => Promise<void> };

/** 进度事件与任务轮询取更靠前的：写入目标不是可写句柄时事件到不了，启动时记下的 0/0 不能盖住轮询。 */
const furtherProgress=(event:ImportProgress,polled:ImportProgress)=>event.done!==polled.done?(event.done>polled.done?event:polled):(event.total>=polled.total?event:polled);

export function ImportMenu({control,...p}:Omit<ComponentProps<typeof ImportBar>,"libraryId"|"libraryName">&{scope?:WorkspaceScope;control?:Ref<ImportControl>}) {
 const [tasks,setTasks]=useState<ImportTaskSnapshot[]>([]),[selectedTask,setSelectedTask]=useState<string|null>(null),[problem,setProblem]=useState<string|null>(null);
 const { t }=useTranslation("importing");
 const context=useSaveDestination();
 const actions=useRef<ImportActions>(null);
 const [busy,setBusy]=useState({busy:false,eagle:false});
 // 这一次导入在对话框里选的位置；没动过时跟着预填（ADR-0016）。只有画师亲手选的才写进记忆，
 // 动作本身指出的位置和失败重试带回的目标只用这一次。
 const [picked,setPicked]=useState<SaveDestination|null|undefined>(undefined);
 const handPicked=useRef(false);
 const destination=picked!==undefined?picked:importPrefill(p.scope,context.memory.importDestination,context.providers);
 const onBusyChange=useCallback((busy:boolean,eagle:boolean)=>{
  setBusy(previous=>previous.busy===busy&&previous.eagle===eagle?previous:{busy,eagle});
  if(!busy){setPicked(undefined);handPicked.current=false;}
 },[]);
 const optimistic=useRef(new Map<string,ImportTaskSnapshot>());
 const dismissed=useRef(new Set<string>());
 // 任务回执的轮询：有进行中的任务时每 400 ms 读一次进度；空闲时每次加倍、最长 3.2 s。
 // 安全模式或工作区变化后立即重读并回到 400 ms。内容没变时不更新状态，卡片不重新渲染。
 const poke=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let alive=true,epoch=0,timer:ReturnType<typeof setTimeout>|undefined,delay=POLL_MIN,last="";
  const schedule=()=>{clearTimeout(timer);if(alive)timer=setTimeout(refresh,delay);};
  const invalidate=()=>{
   epoch++;last="";
   setTasks(previous=>previous.map(task=>({...task,progress:task.report?{done:0,total:0}:task.progress,report:task.report?concealSuccesses(task.report):null})));
   delay=POLL_MIN;schedule();
  };
  const safe=onSafeModeSetting(invalidate),workspace=onWorkspaceChanged(invalidate);
  function refresh(){
   const expected=epoch;
   void importTasks().then(value=>{
    if(!alive||expected!==epoch)return;
    for(const t of value)optimistic.current.delete(t.taskId);
    const next=[...value,...optimistic.current.values()].filter(t=>!dismissed.current.has(t.taskId));
    const busy=next.some(t=>t.report===null||t.finishing);
    delay=busy?POLL_MIN:Math.min(delay*2,POLL_MAX);
    const signature=JSON.stringify(next);
    if(signature!==last){last=signature;setTasks(next);}
   },error=>{
    // 读取期间修订变了只是过时，下一次轮询重读，不显示成问题（#98 本机 r16）。
    if(alive&&expected===epoch&&!isCursorExpired(error))setProblem(errorText(error));
   }).finally(schedule);
  }
  poke.current=()=>{delay=POLL_MIN;schedule();};
  refresh();
  return()=>{alive=false;clearTimeout(timer);poke.current=()=>{};void safe.then(stop=>stop());void workspace.then(stop=>stop());};
 },[]);
 const selected=tasks.find(t=>t.taskId===selectedTask)??tasks.find(t=>t.report===null)??tasks.at(-1);
 const task=selected?{...selected,report:selected.report??(p.finished?.taskId===selected.taskId?concealSuccesses(p.finished.report):null),
   progress:p.running?.taskId===selected.taskId?furtherProgress(p.running.progress,selected.progress):selected.progress}:undefined;
 // 已关闭的回执不再借事件记下的“进行中”复活（#98 本机 r14）。
 const fallbackRunning=p.running&&!(p.running.taskId&&dismissed.current.has(p.running.taskId))?p.running:null;
 const running=task&&(task.report===null||task.finishing)?{taskId:task.taskId,progress:task.progress,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName??undefined}:task?null:fallbackRunning;
 const finished=task?.report&&!task.finishing?{taskId:task.taskId,report:task.report,libraryId:task.destination.libraryId,destination:task.destination,libraryName:task.libraryName,folderName:task.folderName??undefined}:task?null:p.finished?{...p.finished,report:concealSuccesses(p.finished.report)}:null;
 const active=running!==null;
 const library=context.providers.find(provider=>provider.registration.library.id===destination?.libraryId)?.registration.library;
 const via=(action:"files"|"folder")=>()=>{actions.current?.[action]();};
 const eagle=()=>{actions.current?.eagle();};
 // 图片墙空白处右键的“导入 ▸”、Ctrl O 与这里的导入按钮走同一入口；按钮不可用（导入进行中）时也不开始。
 // 回收站里不能发起新的导入（ADR-0016）；任务回执、重试和重新导入不经过这里，照常可用。
 const inTrash=p.scope?.kind==="library"&&p.scope.scope.kind==="trash";
 const blocked=busy.busy||active||inTrash;
 const clipboard=async()=>{
  if(inTrash)return;
  if(blocked)throw { code: "message", message: t("busyClipboard") };
  const path=await stageClipboardImport();
  actions.current?.paths([path]);
 };
 useImperativeHandle(control,()=>({files:()=>{if(!blocked)via("files")();},folder:()=>{if(!blocked)via("folder")();},eagle:()=>{if(!blocked)eagle();},clipboard}));
 const warnings=task?.warnings.map(describeCommandError);
 const notes=<>
  {problem&&<p className="k-task-sub is-danger" role="alert">{problem}</p>}
  {task?.report&&task.finishing&&<p className="k-task-sub" role="status">{t("finishing")}</p>}
  {warnings?.map((warning,index)=><p className="k-task-sub is-warn" role="alert" key={index}><WarnIcon />{warning}</p>)}
 </>;
 const switcher=tasks.length>1?<div className="k-task-switch">{t("tasks")}<Select label={t("tasks")} value={task?.taskId??""} onChange={setSelectedTask}
  options={tasks.map(entry=>({value:entry.taskId,label:t("taskOption",{owner:t("owner",{library:entry.libraryName,folder:entry.folderName??t("unassigned")}),state:t(entry.report?"taskFinished":"taskRunning")})}))}/></div>:null;
 return <div className="import-menu">
  <ImportButton busy={busy.busy||active} eagleBusy={busy.eagle} canStart={!inTrash} onFiles={via("files")} onFolder={via("folder")} onEagle={eagle}
   onShowTasks={tasks.length>0||active||finished?()=>actions.current?.showTasks():undefined}/>
  <ImportBar {...p} actionsRef={actions} onBusyChange={onBusyChange} dropBlocked={inTrash} previewContextKey={context.providers.map(provider=>provider.registration.library.id).join("/")} libraryId={destination?.libraryId??""} libraryName={library?.name??t("noLibraryChosen")}
    destination={destination} destinationReady={context.ready&&destinationAvailable(destination,context.providers)} running={running} finished={finished}
    picker={<SaveDestinationPicker value={destination} onChange={value=>{handPicked.current=true;setPicked(value);}} putInLibrary/>}
    taskSwitcher={switcher} cardNotes={notes} warnings={warnings} onSelectTask={setSelectedTask} ownerLabel={task?t("owner",{library:task.libraryName,folder:task.folderName??t("unassigned")}):null}
    onStarted={(id,fixed)=>{
      if(fixed){
        if(handPicked.current){handPicked.current=false;context.rememberImport(fixed);}
        const provider=context.providers.find(p=>p.registration.library.id===fixed.libraryId);
        optimistic.current.set(id,{taskId:id,destination:fixed,libraryName:provider?.registration.library.name??fixed.libraryId,
          folderName:fixed.folderId===null?null:folderChoices(provider?.sidebar?.folders??[]).find(f=>f.id===fixed.folderId)?.path??t("folderUnavailable"),progress:{done:0,total:0},report:null,finishing:false,warnings:[]});
        setTasks(previous=>previous.some(t=>t.taskId===id)?previous:[...previous,optimistic.current.get(id)!]);
      }
      setSelectedTask(id);p.onStarted(id,fixed);poke.current();
    }} onRetryDestination={value=>{handPicked.current=false;setPicked(value);}} onDismissReport={()=>{
      if(task?.report){
        optimistic.current.delete(task.taskId);dismissed.current.add(task.taskId);
        setTasks(previous=>previous.filter(t=>t.taskId!==task.taskId));
        void dismissImport(task.destination.libraryId,task.taskId).catch(error=>{dismissed.current.delete(task.taskId);setProblem(errorText(error));});
      }
      p.onDismissReport();
    }}/>
 </div>;
}
