import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { App } from "../App";
import { ImportMenu } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";
import { WorkspaceSourceEditor } from "./WorkspaceSourceEditor";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
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

it("retry starts at its original target and an explicit new choice matches the final submitted target",async()=>{
 let submitted:unknown;
 const receipt={taskId:"failed-B",destination:{libraryId:"B",folderId:null},libraryName:"保存库",folderName:"未归类",progress:{done:1,total:1},finishing:false,warnings:[],report:{items:[{path:"C:/failed.png",outcome:{kind:"readFailed",reason:"locked"}}],cancelled:false,fromEagle:false,eagleMissing:0,eagleRelocations:[]}};
 mockIPC((cmd,args)=>{
  if(cmd==="plugin:library|workspace_directories")return {status:{revision:"test",libraries},providers:libraries.map(registration=>({registration,sidebar:{all:0,trash:0,folders:[]},unassigned:0,descendants:{}}))};
  if(cmd==="plugin:library|import_tasks")return [receipt];
  if(cmd==="plugin:library|import_contains_eagle")return false;
  if(cmd==="plugin:library|start_import"){submitted=args;return "retry-task";}
  if(cmd==="plugin:library|recovery")return {interrupted:[],orphans:[]};
  return null;
 },{shouldMockEvents:true});
 render(<SaveDestinationProvider safe><ImportMenu enabled libraryId="A" libraryName="浏览库" running={null} finished={null} onStarted={()=>{}} onDismissReport={()=>{}}/></SaveDestinationProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"重试失败的 1 项"}));
 await screen.findByRole("button",{name:"开始导入"});
 expect((screen.getByRole("combobox",{name:"保存到资料库"}) as HTMLSelectElement).value).toBe("B");
 fireEvent.change(screen.getByRole("combobox",{name:"保存到资料库"}),{target:{value:"A"}});
 expect(screen.getByText("最终位置：浏览库 / 未归类")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"开始导入"}));
 await waitFor(()=>expect(submitted).toMatchObject({libraryId:"A",destination:{libraryId:"A",folderId:null}}));
});

it("a concrete folder entry prefills its provider and folder without activating it",async()=>{
 mockIPC(cmd=>{
  if(cmd==="plugin:library|workspace_directories")return {status:{revision:"test",libraries},providers:libraries.map(registration=>({registration,sidebar:{all:0,trash:0,folders:[{id:"folder-b",name:"具体目录",children:[],count:0}]},unassigned:0,descendants:{}}))};
  if(cmd==="plugin:library|import_tasks")return [];
  return null;
 },{shouldMockEvents:true});
 render(<SaveDestinationProvider safe><ImportMenu enabled libraryId="A" libraryName="浏览库" scope={{kind:"library",libraryId:"B",scope:{kind:"folder",id:"folder-b"}}} running={null} finished={null} onStarted={()=>{}} onDismissReport={()=>{}}/></SaveDestinationProvider>);
 fireEvent.click(screen.getByRole("button",{name:"导入参考图"}));
 expect(await screen.findByText("最终位置：保存库 / 具体目录")).toBeTruthy();
 expect((screen.getByRole("combobox",{name:"保存到资料库"}) as HTMLSelectElement).value).toBe("B");
 expect((screen.getByRole("combobox",{name:"保存到文件夹"}) as HTMLSelectElement).value).toBe("folder-b");
});


it("copy keeps its confirmation during a source refresh and closes it after the real reply", async () => {
  let finishCopy!: () => void;
  const pendingCopy = new Promise<void>(resolve => { finishCopy = resolve; });
  let finishInspection!: (value: unknown) => void;
  const pendingInspection = new Promise(resolve => { finishInspection = resolve; });
  let refreshed = false;
  const inspection = {
    detail: { id: "a", originalName: "same.png", width: 100, height: 200, folders: [], note: { manual: "原来源备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: "a", suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] } },
    tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 1, trash: 0, folders: [] },
  };
  const card: WorkspaceCard = { id: "same-bytes", width: 100, height: 200, thumbnail: "A/a/256", adult: false, libraryId: "A", imageId: "a", sources: [{ libraryId: "A", libraryName: "浏览库", imageId: "a", matches: true, unavailable: null, deleted: false }] };
  mockIPC(cmd => {
    if (cmd === "plugin:library|workspace_directories") return { status: { revision: "test", libraries }, providers: libraries.map(registration => ({ registration, sidebar: inspection.sidebar, unassigned: 0, descendants: {} })) };
    if (cmd === "plugin:library|workspace_source_inspection") return refreshed ? pendingInspection : inspection;
    if (cmd === "plugin:library|workspace_sidebar") return inspection.sidebar;
    if (cmd === "plugin:desktop|reference_groups") return [];
    if (cmd === "plugin:library|workspace_copy_source") return pendingCopy;
    return null;
  }, { shouldMockEvents: true });
  const view = (reloadKey: number) => <SaveDestinationProvider safe><WorkspaceSourceEditor card={card} source={card.sources[0]} safe reloadKey={reloadKey} onSource={() => {}} onClose={() => {}} /></SaveDestinationProvider>;
  const rendered = render(view(0));
  fireEvent.click(await screen.findByRole("button", { name: "复制到资料库…" }));
  const dialog = screen.getByRole("dialog", { name: "复制此来源" });
  fireEvent.change(await within(dialog).findByRole("combobox", { name: "保存到资料库" }), { target: { value: "B" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认复制" }));
  await screen.findByRole("button", { name: "正在保存…" });
  refreshed = true;
  rendered.rerender(view(1));
  await screen.findByText("正在读取该来源…");
  expect(screen.getByRole("dialog", { name: "复制此来源" })).toBeTruthy();
  await act(async () => { finishCopy(); await pendingCopy; });
  await act(async () => { finishInspection(inspection); await pendingInspection; });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "复制此来源" })).toBeNull());
});
