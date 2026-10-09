import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it } from "vitest";
import { SettingsPanel } from "../SettingsPanel";
import type { TagLabel } from "../bindings/TagLabel";
const label=(id:string,name:string):TagLabel=>({id,name,namespace:"general",untranslated:false,hasExternal:false});
const defaults={autostart:false,shortcuts:[],showApproxSource:false,forceSrgb:false,forceSrgbInEffect:false,usageLog:false};
afterEach(()=>{cleanup();clearMocks();});
it("lists and deletes application rules without an active library",async()=>{
  let entries=[{a:label("blue","蓝瞳"),b:label("sky","天空色"),relation:"similar",sources:[]}];
  const calls:{cmd:string,args:unknown}[]=[];
  mockIPC((cmd,args)=>{
    calls.push({cmd,args});
    if(cmd==="shell_settings")return defaults;
    if(cmd.endsWith("safe_mode"))return true;
    if(cmd.endsWith("workspace_status"))return {revision:"r1",libraries:[]};
    if(cmd.endsWith("shared_personal_approx"))return {revision:1,entries,conflicts:[]};
    if(cmd.endsWith("edit_shared_approx")){entries=[];return null;}
    return undefined;
  },{shouldMockEvents:true});
  render(<SettingsPanel library={null}/>);
  const table=await screen.findByRole("table",{name:"个人近似对应表"});
  expect(within(table).getByText(/蓝瞳/)).toBeTruthy();
  fireEvent.click(within(table).getByRole("button",{name:"删除"}));
  await waitFor(()=>expect(screen.queryByRole("table",{name:"个人近似对应表"})).toBeNull());
  expect(calls.find(c=>c.cmd.endsWith("edit_shared_approx"))?.args).toEqual({edit:{kind:"remove",a:"blue",b:"sky"},safeMode:true});
});

import { SearchBox } from "./SearchBox";
it("workspace search saves forever using shared IDs and preserves once as current input",async()=>{
  const calls:{cmd:string,args:unknown}[]=[];const changes:unknown[]=[];
  mockIPC((cmd,args)=>{calls.push({cmd,args});return undefined;},{shouldMockEvents:true});
  const blue=label("shared-blue","蓝瞳"),aqua=label("shared-aqua","水色瞳");
  render(<SearchBox workspace libraryId="currently-browsed-B" safe generation={1} input={{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[]}],negate:false}],exact:false}} tree={{conditions:[{any:[{kind:"tag",tag:blue,similar:[{tag:aqua,source:"builtin",of:[blue.id]}]}],negate:false}]}} showSource={false} onChange={value=>changes.push(value)} onError={error=>{throw Error(error);}}/>);
  fireEvent.click(screen.getByRole("button",{name:"不展开“水色瞳”"}));
  fireEvent.click(screen.getByRole("button",{name:"只这次"}));
  expect(changes).toEqual([{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[aqua.id]}],negate:false}],exact:false}]);
  expect(calls.some(c=>c.cmd.endsWith("edit_shared_approx"))).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"不展开“水色瞳”"}));
  fireEvent.click(screen.getByRole("button",{name:"以后都不展开"}));
  await waitFor(()=>expect(calls.find(c=>c.cmd.endsWith("edit_shared_approx"))?.args).toEqual({edit:{kind:"set",rules:[{a:blue.id,b:aqua.id,relation:"notSimilar"}]},safeMode:true}));
});

import { emit } from "@tauri-apps/api/event";
it("shows legacy disagreement as pending and submits an explicit conflict choice",async()=>{
  const calls:{cmd:string,args:unknown}[]=[];
  const conflict={a:label("blue","蓝瞳"),b:label("aqua","水色瞳"),current:null,sources:[{libraryId:"A",libraryName:"同名库",libraryRoot:"D:/A",relation:"similar"},{libraryId:"B",libraryName:"同名库",libraryRoot:"E:/B",relation:"notSimilar"}]};
  mockIPC((cmd,args)=>{calls.push({cmd,args});if(cmd==="shell_settings")return defaults;if(cmd.endsWith("safe_mode"))return true;if(cmd.endsWith("workspace_status"))return {revision:"r1",libraries:[]};if(cmd.endsWith("shared_personal_approx"))return {revision:7,entries:[],conflicts:[conflict]};return undefined;},{shouldMockEvents:true});
  render(<SettingsPanel/>);
  const group=await screen.findByRole("group",{name:"个人近似规则冲突"});
  expect(group.textContent).toContain("尚未保存为“不相近”");expect(group.textContent).toContain("D:/A");expect(group.textContent).toContain("E:/B");
  fireEvent.click(within(group).getByRole("button",{name:"不采用旧规则"}));
  await waitFor(()=>expect(calls.find(c=>c.cmd.endsWith("edit_shared_approx"))?.args).toEqual({edit:{kind:"resolveConflict",a:"blue",b:"aqua",revision:7,relation:null},safeMode:true}));
});
it("does not release a late unsafe rule list after safe mode changes",async()=>{
  let resolveOld:(value:unknown)=>void=()=>{};
  let oldStarted=false;
  const old=new Promise(resolve=>{resolveOld=resolve;});
  mockIPC((cmd,args)=>{if(cmd==="shell_settings")return defaults;if(cmd.endsWith("safe_mode"))return false;if(cmd.endsWith("workspace_status"))return {revision:"r1",libraries:[]};if(cmd.endsWith("shared_personal_approx")){if((args as {safeMode:boolean}).safeMode)return {revision:2,entries:[],conflicts:[]};oldStarted=true;return old;}return undefined;},{shouldMockEvents:true});
  render(<SettingsPanel/>);
  await screen.findByRole("checkbox",{name:"显示相近标签来源（内置／个人）"});
  await waitFor(()=>expect(oldStarted).toBe(true));
  await act(async()=>{await emit("safe-mode-setting",true);});
  await act(async()=>{resolveOld({revision:1,entries:[{a:label("secret","封印旧标签"),b:label("other","另一标签"),relation:"similar",sources:[]}],conflicts:[]});await old;});
  expect(screen.queryByText(/封印旧标签/)).toBeNull();
});
it("workspace plus chooses an unmapped visible tag and saves one global rule",async()=>{
  const calls:{cmd:string,args:unknown}[]=[];const sky=label("shared-sky","天空色"),blue=label("shared-blue","蓝瞳");
  mockIPC((cmd,args)=>{calls.push({cmd,args});if(cmd.endsWith("workspace_candidates"))return [{tag:sky,via:null,count:1}];return undefined;});
  render(<SearchBox workspace libraryId="B" safe generation={1} input={{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[]}],negate:false}],exact:false}} tree={{conditions:[{any:[{kind:"tag",tag:blue,similar:[]}],negate:false}]}} showSource={false} onChange={()=>{}} onError={error=>{throw Error(error);}}/>);
  fireEvent.click(screen.getByRole("button",{name:"给“蓝瞳”加相近标签"}));
  fireEvent.change(screen.getByRole("combobox",{name:"挑一个统一标签"}),{target:{value:"天空"}});
  fireEvent.click(await screen.findByRole("option",{name:/天空色/}));
  await waitFor(()=>expect(calls.find(c=>c.cmd.endsWith("edit_shared_approx"))?.args).toEqual({edit:{kind:"set",rules:[{a:blue.id,b:sky.id,relation:"similar"}]},safeMode:true}));
});
