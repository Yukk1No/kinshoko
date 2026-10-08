import { useEffect, useRef, useState } from "react";
import type { CatalogApproxEdit } from "../bindings/CatalogApproxEdit";
import type { CatalogApproxView } from "../bindings/CatalogApproxView";
import { editSharedApprox, isLensChanged, onSafeModeSetting, onWorkspaceChanged, safeMode, sharedPersonalApprox, workspaceStatus } from "../ipc";
import { libraryPathHint } from "../library/library-path";
import { TagMarks, tagName, UI_LANG } from "./SearchBox";

const relationName=(relation:string)=>relation==="similar"?"相近":"不相近";
/** Same formal settings structure, with stable shared identities and source-aware conflict choices. */
export function SharedPersonalApproxSettings({onError}:{onError:(message:string)=>void}) {
  const [safe,setSafe]=useState<boolean|null>(null);
  const [generation,setGeneration]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [found,setFound]=useState<{key:string;view:CatalogApproxView}|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const mode=useRef(0),revision=useRef<string|null>(null),events=useRef(0);
  const key=JSON.stringify([safe,generation,refresh]);const current=useRef(key);current.current=key;
  const view=found?.key===key?found.view:null;
  useEffect(()=>{
    let alive=true;const initial=mode.current;
    const baseline=async(on:boolean,expected:number)=>{
      const event=events.current;
      try {const status=await workspaceStatus(on);if(alive&&mode.current===expected&&events.current===event)revision.current=status?.revision??null;}
      catch(error){if(alive&&mode.current===expected&&!isLensChanged(error))onError(String(error));}
    };
    void safeMode().then(async(on)=>{if(!alive||mode.current!==initial||typeof on!=="boolean")return;await baseline(on,initial);if(alive&&mode.current===initial)setSafe(on);}).catch(error=>{if(alive&&mode.current===initial)onError(String(error));});
    const stopMode=onSafeModeSetting(on=>{if(!alive)return;mode.current++;setSafe(on);setGeneration(n=>n+1);void baseline(on,mode.current);});
    const stopWorkspace=onWorkspaceChanged(status=>{if(!alive)return;events.current++;if(revision.current===status.revision)return;revision.current=status.revision;setGeneration(n=>n+1);});
    return ()=>{alive=false;for(const stop of [stopMode,stopWorkspace])void stop.then(unlisten=>unlisten()).catch(()=>{});};
  },[onError]);
  useEffect(()=>{
    if(safe===null)return;let alive=true;
    void sharedPersonalApprox(UI_LANG,safe).then(value=>{if(alive&&current.current===key)setFound({key,view:value??{revision:0,entries:[],conflicts:[]}});},error=>{if(alive&&current.current===key)onError(String(error));});
    return ()=>{alive=false;};
  },[safe,key,onError]);
  const edit=async(action:CatalogApproxEdit)=>{
    if(safe===null)return;setPending(key);
    try {await editSharedApprox(action,safe);if(current.current===key)setRefresh(n=>n+1);}
    catch(error){if(current.current===key)onError(String(error));}
    finally {setPending(value=>value===key?null:value);}
  };
  const busy=pending===key;
  return <section aria-label="全局个人近似规则" aria-busy={busy}>
    <p className="settings-hint">个人规则在各资料库共用。“只这次”仅改当前查找；“以后都不展开”和“＋”保存长期判断。</p>
    {view===null?<p role="status">正在读取个人近似规则…</p>:<>
      {view.entries.length===0?<p className="settings-hint">个人近似对应表还是空的。查找时关掉相近标签选“以后都不展开”，或用“＋”加相近标签，会记在这里。</p>:<table className="settings-approx" aria-label="个人近似对应表"><tbody>
        {view.entries.map(entry=><tr key={`${entry.a.id}/${entry.b.id}`}>
          <td>{tagName(entry.a)}<TagMarks tag={entry.a}/>～{tagName(entry.b)}<TagMarks tag={entry.b}/></td>
          <td>{relationName(entry.relation)}</td>
          <td><button type="button" disabled={busy} onClick={()=>void edit({kind:"remove",a:entry.a.id,b:entry.b.id})}>删除</button></td>
          {!!entry.sources.length&&<td>来自：{entry.sources.map(source=><span key={source.libraryId} title={source.libraryRoot}>{source.libraryName}（{libraryPathHint(source.libraryRoot, entry.sources.map(item => item.libraryRoot))}） </span>)}</td>}
        </tr>)}
      </tbody></table>}
      {view.conflicts.map(conflict=><div role="group" aria-label="个人近似规则冲突" key={`${conflict.a.id}/${conflict.b.id}`}>
        <h3>{tagName(conflict.a)} ～ {tagName(conflict.b)}</h3>
        <p>{conflict.current===null?"旧资料库的判断相反。尚未选择，暂不展开这一对；尚未保存为“不相近”。":`当前全局判断为“${relationName(conflict.current)}”。旧来源不得覆盖它；不采用旧规则会保留当前判断。`}</p>
        <ul>{conflict.sources.map((source,index)=><li key={`${source.libraryId}/${index}`} title={source.libraryRoot}>{source.libraryName}（{libraryPathHint(source.libraryRoot, conflict.sources.map(item => item.libraryRoot))}）：{relationName(source.relation)}</li>)}</ul>
        <div className="settings-actions">{([{relation:"similar",name:"相近"},{relation:"notSimilar",name:"不相近"},{relation:null,name:"不采用旧规则"}] as const).map(choice=><button key={choice.name} type="button" disabled={busy} onClick={()=>void edit({kind:"resolveConflict",a:conflict.a.id,b:conflict.b.id,revision:view.revision,relation:choice.relation})}>{choice.name}</button>)}</div>
      </div>)}
    </>}
  </section>;
}
