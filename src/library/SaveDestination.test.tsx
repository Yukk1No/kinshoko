import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { App } from "../App";
const a={ id:"A",name:"浏览库",root:"C:/a" }, b={ id:"B",name:"保存库",root:"D:/b" };
const libraries=[a,b].map(library=>({library,unavailable:null}));
beforeEach(()=>{
 Object.defineProperty(HTMLElement.prototype,"clientWidth",{configurable:true,get:()=>1000});
 Object.defineProperty(HTMLElement.prototype,"clientHeight",{configurable:true,get:()=>800});
 vi.stubGlobal("ResizeObserver",class{observe(){} disconnect(){}}); mockConvertFileSrc("windows"); mockWindows("main");
});
afterEach(async()=>{cleanup();await new Promise(r=>setTimeout(r,0));clearMocks();vi.unstubAllGlobals();});
it("global import requires a visible save destination and does not change browse scope",async()=>{
 let submitted:unknown=null; const scopes:unknown[]=[];
 const side={all:0,trash:0,folders:[{id:"folder-b",name:"最终目录",count:0,children:[]}]};
 mockIPC((cmd,args)=>{
  if(cmd==="tagging_status")return {libraryId:"A",status:{kind:"idle"}};
  if(cmd==="app_info")return {productName:"Kinshoko",version:"1"};
  if(cmd==="plugin:library|safe_mode")return true;
  if(cmd==="plugin:library|current_library")return a;
  if(cmd==="plugin:library|registered_libraries")return libraries;
  if(cmd==="plugin:library|workspace_status")return {revision:"test",libraries};
  if(cmd==="plugin:library|workspace_directories")return {status:{revision:"test",libraries},providers:libraries.map(registration=>({registration,sidebar:side,unassigned:0,descendants:{}}))};
  if(cmd==="plugin:library|workspace_browse"){scopes.push((args as {query:{scope:unknown}}).query.scope);return {cards:[],total:0,nextCursor:null,status:{revision:"test",libraries}};}
  if(cmd==="plugin:library|pick_files")return ["C:/source.png"];
  if(cmd==="plugin:library|import_contains_eagle")return false;
  if(cmd==="plugin:library|start_import"){submitted=args;return "fixed-task";}
  if(cmd==="plugin:library|import_tasks")return [];
  if(cmd==="plugin:library|recovery")return {interrupted:[],orphans:[]};
  return null;
 },{shouldMockEvents:true});
 render(<App/>);
 fireEvent.click(await screen.findByRole("button",{name:"导入参考图"}));
 const menu=screen.getByRole("button",{name:"关闭导入操作"}).closest(".import-popup") as HTMLElement;
 fireEvent.change(await within(menu).findByRole("combobox",{name:"保存到资料库"}),{target:{value:"B"}});
 fireEvent.change(within(menu).getByRole("combobox",{name:"保存到文件夹"}),{target:{value:"folder-b"}});
 expect(within(menu).getByText(/最终位置：保存库.*最终目录/)).toBeTruthy();
 fireEvent.click(within(menu).getByRole("button",{name:"导入文件…"}));
 fireEvent.click(await within(menu).findByRole("button",{name:"开始导入"}));
 await waitFor(()=>expect(submitted).toMatchObject({libraryId:"B",destination:{libraryId:"B",folderId:"folder-b"},source:{paths:["C:/source.png"]}}));
 expect(scopes.every(scope=>JSON.stringify(scope)==='{"kind":"all"}')).toBe(true);
});

it("a late start reply and cancel keep the submitted owner after selecting another target",async()=>{
 let resolveStart:(id:string)=>void=()=>{};
 const pendingStart=new Promise<string>(resolve=>{resolveStart=resolve;});
 let cancelled:unknown;
 const side={all:0,trash:0,folders:[]};
 mockIPC((cmd,args)=>{
  if(cmd==="tagging_status")return {libraryId:"A",status:{kind:"idle"}};
  if(cmd==="app_info")return {productName:"Kinshoko",version:"1"};
  if(cmd==="plugin:library|safe_mode")return true;
  if(cmd==="plugin:library|current_library")return a;
  if(cmd==="plugin:library|registered_libraries")return libraries;
  if(cmd==="plugin:library|workspace_status")return {revision:"test",libraries};
  if(cmd==="plugin:library|workspace_directories")return {status:{revision:"test",libraries},providers:libraries.map(registration=>({registration,sidebar:side,unassigned:0,descendants:{}}))};
  if(cmd==="plugin:library|workspace_browse")return {cards:[],total:0,nextCursor:null,status:{revision:"test",libraries}};
  if(cmd==="plugin:library|pick_files")return ["C:/source.png"];
  if(cmd==="plugin:library|import_contains_eagle")return false;
  if(cmd==="plugin:library|start_import")return pendingStart;
  if(cmd==="plugin:library|cancel_import"){cancelled=args;return null;}
  if(cmd==="plugin:library|import_tasks")return [];
  if(cmd==="plugin:library|library_recovery")return {interrupted:[],orphans:[]};
  return null;
 },{shouldMockEvents:true});
 render(<App/>);
 fireEvent.click(await screen.findByRole("button",{name:"导入参考图"}));
 fireEvent.change(await screen.findByRole("combobox",{name:"保存到资料库"}),{target:{value:"B"}});
 fireEvent.click(screen.getByRole("button",{name:"导入文件…"}));
 fireEvent.click(await screen.findByRole("button",{name:"开始导入"}));
 fireEvent.change(screen.getByRole("combobox",{name:"保存到资料库"}),{target:{value:"A"}});
 await act(async()=>{resolveStart("late-task");await pendingStart;});
 expect(await screen.findByText("任务保存位置：保存库 / 未归类")).toBeTruthy();
 fireEvent.click(await screen.findByRole("button",{name:"取消导入"}));
 await waitFor(()=>expect(cancelled).toEqual({libraryId:"B",taskId:"late-task"}));
 expect(screen.getByText("最终位置：浏览库 / 未归类")).toBeTruthy();
});
