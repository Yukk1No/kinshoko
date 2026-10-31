import { useEffect, useRef, useState } from "react";
import type { CatalogApproxEdit } from "../bindings/CatalogApproxEdit";
import type { CatalogApproxView } from "../bindings/CatalogApproxView";
import { editSharedApprox, isLensChanged, onSafeModeSetting, onWorkspaceChanged, safeMode, sharedPersonalApprox, workspaceStatus } from "../ipc";
import { libraryPathHint } from "../library/library-path";
import { TagMarks, tagName } from "./SearchBox";
import { useUiLang } from "../i18n";
import { i18n } from "../i18n/instance";
import { useTranslation } from "react-i18next";

const relationName=(relation:string)=>i18n.t(relation==="similar"?"tagSettings:approx.similar":"tagSettings:approx.notSimilar");
/** Same formal settings structure, with stable shared identities and source-aware conflict choices. */
export function SharedPersonalApproxSettings({onError}:{onError:(error:unknown)=>void}) {
  const [safe,setSafe]=useState<boolean|null>(null);
  const [generation,setGeneration]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [found,setFound]=useState<{key:string;view:CatalogApproxView}|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const mode=useRef(0),revision=useRef<string|null>(null),events=useRef(0);
  const lang=useUiLang();
  const {t}=useTranslation("tagSettings",{keyPrefix:"approx"});
  const key=JSON.stringify([safe,generation,refresh,lang]);const current=useRef(key);current.current=key;
  const view=found?.key===key?found.view:null;
  useEffect(()=>{
    let alive=true;const initial=mode.current;
    const baseline=async(on:boolean,expected:number)=>{
      const event=events.current;
      try {const status=await workspaceStatus(on);if(alive&&mode.current===expected&&events.current===event)revision.current=status?.revision??null;}
      catch(error){if(alive&&mode.current===expected&&!isLensChanged(error))onError(error);}
    };
    void safeMode().then(async(on)=>{if(!alive||mode.current!==initial||typeof on!=="boolean")return;await baseline(on,initial);if(alive&&mode.current===initial)setSafe(on);}).catch(error=>{if(alive&&mode.current===initial)onError(error);});
    const stopMode=onSafeModeSetting(on=>{if(!alive)return;mode.current++;setSafe(on);setGeneration(n=>n+1);void baseline(on,mode.current);});
    const stopWorkspace=onWorkspaceChanged(status=>{if(!alive)return;events.current++;if(revision.current===status.revision)return;revision.current=status.revision;setGeneration(n=>n+1);});
    return ()=>{alive=false;for(const stop of [stopMode,stopWorkspace])void stop.then(unlisten=>unlisten()).catch(()=>{});};
  },[onError]);
  useEffect(()=>{
    if(safe===null)return;let alive=true;
    void sharedPersonalApprox(lang,safe).then(value=>{if(alive&&current.current===key)setFound({key,view:value??{revision:0,entries:[],conflicts:[]}});},error=>{if(alive&&current.current===key)onError(error);});
    return ()=>{alive=false;};
  },[safe,key,onError,lang]);
  const edit=async(action:CatalogApproxEdit)=>{
    if(safe===null)return;setPending(key);
    try {await editSharedApprox(action,safe);if(current.current===key)setRefresh(n=>n+1);}
    catch(error){if(current.current===key)onError(error);}
    finally {setPending(value=>value===key?null:value);}
  };
  const busy=pending===key;
  return <section aria-label={t("label")} aria-busy={busy}>
    <p className="k-set-note">{t("note")}</p>
    {view===null?<p role="status">{t("loading")}</p>:<>
      {view.entries.length===0?<p className="k-set-note">{t("empty")}</p>:<table className="settings-approx" aria-label={t("table")}><tbody>
        {view.entries.map(entry=><tr key={`${entry.a.id}/${entry.b.id}`}>
          <td>{tagName(entry.a)}<TagMarks tag={entry.a}/>{t("pairSeparator")}{tagName(entry.b)}<TagMarks tag={entry.b}/></td>
          <td>{relationName(entry.relation)}</td>
          <td><button type="button" className="k-btn is-sm is-quiet" disabled={busy} onClick={()=>void edit({kind:"remove",a:entry.a.id,b:entry.b.id})}><span className="k-label">{t("remove")}</span></button></td>
          {!!entry.sources.length&&<td>{t("from")}{entry.sources.map(source=><span key={source.libraryId} title={source.libraryRoot}>{t("source",{name:source.libraryName,path:libraryPathHint(source.libraryRoot, entry.sources.map(item => item.libraryRoot))})}</span>)}</td>}
        </tr>)}
      </tbody></table>}
      {view.conflicts.map(conflict=><div role="group" aria-label={t("conflict")} className="k-approx-conflict" key={`${conflict.a.id}/${conflict.b.id}`}>
        <h3>{t("pair",{a:tagName(conflict.a),b:tagName(conflict.b)})}</h3>
        <p className="k-set-note">{conflict.current===null?t("undecided"):t("current",{relation:relationName(conflict.current)})}</p>
        <ul>{conflict.sources.map((source,index)=><li key={`${source.libraryId}/${index}`} title={source.libraryRoot}>{t("sourceRelation",{name:source.libraryName,path:libraryPathHint(source.libraryRoot, conflict.sources.map(item => item.libraryRoot)),relation:relationName(source.relation)})}</li>)}</ul>
        <div className="k-set-inline">{([{relation:"similar",name:t("similar")},{relation:"notSimilar",name:t("notSimilar")},{relation:null,name:t("keep")}] as const).map(choice=><button key={choice.name} type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void edit({kind:"resolveConflict",a:conflict.a.id,b:conflict.b.id,revision:view.revision,relation:choice.relation})}><span className="k-label">{choice.name}</span></button>)}</div>
      </div>)}
    </>}
  </section>;
}
