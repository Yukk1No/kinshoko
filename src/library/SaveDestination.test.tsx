import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { App } from "../App";
import { appStartup } from "../App.fixtures";
import { fakeBackend } from "../test/backend";
import { ImportMenu } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";
import { chooseOption } from "../test/select";
const a={ id:"A",name:"浏览库",root:"C:/a" }, b={ id:"B",name:"保存库",root:"D:/b" };
const libraries=[a,b].map(library=>({library,unavailable:null}));
beforeEach(()=>{
 Object.defineProperty(HTMLElement.prototype,"clientWidth",{configurable:true,get:()=>1000});
 Object.defineProperty(HTMLElement.prototype,"clientHeight",{configurable:true,get:()=>800});
 mockConvertFileSrc("windows");
});
afterEach(()=>{vi.unstubAllGlobals();});
it("global import shows the prefilled destination, can be changed by hand and does not change browse scope",async()=>{
 let submitted:unknown=null; const scopes:unknown[]=[];
 const side={all:0,trash:0,folders:[{id:"folder-b",name:"最终目录",count:0,children:[]}]};
 fakeBackend({
  ...appStartup,
  tagging_status:{state:"starting"},
  app_info:{productName:"Kinshoko",version:"1"},
  current_library:a,
  registered_libraries:libraries,
  workspace_status:{revision:"test",libraries},
  workspace_directories:{status:{revision:"test",libraries},registrationOrder: [], providers:libraries.map(registration=>({registration,sidebar:side,unassigned:0,descendants:{}}))},
  workspace_browse:(args)=>{scopes.push((args as {query:{scope:unknown}}).query.scope);return {cards:[],total:0,nextCursor:null,status:{revision:"test",libraries}};},
  pick_files:["C:/source.png"],
  import_contains_eagle:false,
  start_import:(args)=>{submitted=args;return "fixed-task";},
  import_tasks:[],
  recovery:{interrupted:[],orphans:[]},
 });
 render(<App/>);
 // #98: the split button picks files first; the panel then asks where to save before anything starts.
 fireEvent.click(await screen.findByRole("button",{name:"导入"}));
 fireEvent.click(await screen.findByRole("menuitem",{name:/^图片/}));
 const start=await screen.findByRole("button",{name:"开始导入"});
 const menu=screen.getByRole("dialog",{name:"导入图片"});
 expect(submitted).toBeNull();
 await within(menu).findByText(/放到：浏览库/);
 await chooseOption(await within(menu).findByRole("combobox",{name:"放到图库"}),/^保存库/);
 await chooseOption(within(menu).getByRole("combobox",{name:"文件夹"}),"最终目录");
 expect(within(menu).getByText(/放到：保存库.*最终目录/)).toBeTruthy();
 await waitFor(()=>expect(start).toHaveProperty("disabled",false));
 fireEvent.click(start);
 await waitFor(()=>expect(submitted).toMatchObject({libraryId:"B",destination:{libraryId:"B",folderId:"folder-b"},source:{paths:["C:/source.png"]}}));
 expect(scopes.every(scope=>JSON.stringify(scope)==='{"kind":"all"}')).toBe(true);
});

it("a late start reply and cancel keep the submitted owner after selecting another target",async()=>{
 let resolveStart:(id:string)=>void=()=>{};
 const pendingStart=new Promise<string>(resolve=>{resolveStart=resolve;});
 let cancelled:unknown;
 const side={all:0,trash:0,folders:[]};
 fakeBackend({
  ...appStartup,
  tagging_status:{state:"starting"},
  app_info:{productName:"Kinshoko",version:"1"},
  current_library:a,
  registered_libraries:libraries,
  workspace_status:{revision:"test",libraries},
  workspace_directories:{status:{revision:"test",libraries},registrationOrder: [], providers:libraries.map(registration=>({registration,sidebar:side,unassigned:0,descendants:{}}))},
  workspace_browse:{cards:[],total:0,nextCursor:null,status:{revision:"test",libraries}},
  pick_files:["C:/source.png"],
  import_contains_eagle:false,
  start_import:()=>pendingStart,
  cancel_import:(args)=>{cancelled=args;return null;},
  import_tasks:[],
 });
 render(<App/>);
 fireEvent.click(await screen.findByRole("button",{name:"导入"}));
 fireEvent.click(await screen.findByRole("menuitem",{name:/^图片/}));
 const start=await screen.findByRole("button",{name:"开始导入"});
 await chooseOption(await screen.findByRole("combobox",{name:"放到图库"}),/^保存库/);
 await waitFor(()=>expect(start).toHaveProperty("disabled",false));
 fireEvent.click(start);
 await chooseOption(screen.getByRole("combobox",{name:"放到图库"}),/^浏览库/);
 await act(async()=>{resolveStart("late-task");await pendingStart;});
 expect(await screen.findByText("放到 保存库 / 未归类")).toBeTruthy();
 fireEvent.click(await screen.findByRole("button",{name:"取消导入"}));
 await waitFor(()=>expect(cancelled).toEqual({libraryId:"B",taskId:"late-task"}));
 // 卡片上的保存位置仍是提交时的保存库，不跟着之后的新选择变。
 expect(screen.getByText("放到 保存库 / 未归类")).toBeTruthy();
 expect(screen.queryByText("放到 浏览库 / 未归类")).toBeNull();
});

it("retry starts at its original target and an explicit new choice matches the final submitted target",async()=>{
 let submitted:unknown;
 const receipt={taskId:"failed-B",destination:{libraryId:"B",folderId:null},libraryName:"保存库",folderName:"未归类",progress:{done:1,total:1},finishing:false,warnings:[],report:{items:[{path:"C:/failed.png",outcome:{kind: "readFailed", reason: { code: "system", detail: "locked" }}}],cancelled:false,fromEagle:false,eagleMissing:0,eagleRelocations:[]}};
 fakeBackend({
  workspace_directories:{status:{revision:"test",libraries},registrationOrder: [], providers:libraries.map(registration=>({registration,sidebar:{all:0,trash:0,folders:[]},unassigned:0,descendants:{}}))},
  import_tasks:[receipt],
  import_contains_eagle:false,
  start_import:(args)=>{submitted=args;return "retry-task";},
  recovery:{interrupted:[],orphans:[]},
 });
 render(<SaveDestinationProvider safe><ImportMenu enabled running={null} finished={null} onStarted={()=>{}} onDismissReport={()=>{}}/></SaveDestinationProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"查看"}));
 fireEvent.click(await screen.findByRole("button",{name:"重试失败的 1 项"}));
 await screen.findByRole("button",{name:"开始导入"});
 expect(screen.getByRole("combobox",{name:"放到图库"}).textContent).toMatch(/^保存库/);
 await chooseOption(screen.getByRole("combobox",{name:"放到图库"}),/^浏览库/);
 expect(screen.getByText("放到：浏览库 / 未归类")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"开始导入"}));
 await waitFor(()=>expect(submitted).toMatchObject({libraryId:"A",destination:{libraryId:"A",folderId:null}}));
});

it("a concrete folder entry prefills its provider and folder without activating it",async()=>{
 fakeBackend({
  workspace_directories:{status:{revision:"test",libraries},registrationOrder: [], providers:libraries.map(registration=>({registration,sidebar:{all:0,trash:0,folders:[{id:"folder-b",name:"具体目录",children:[],count:0}]},unassigned:0,descendants:{}}))},
  import_tasks:[],
  pick_files:["C:/source.png"],
  import_contains_eagle:false,
 });
 render(<SaveDestinationProvider safe><ImportMenu enabled scope={{kind:"library",libraryId:"B",scope:{kind:"folder",id:"folder-b"}}} running={null} finished={null} onStarted={()=>{}} onDismissReport={()=>{}}/></SaveDestinationProvider>);
 fireEvent.click(screen.getByRole("button",{name:"导入"}));
 fireEvent.click(await screen.findByRole("menuitem",{name:/^图片/}));
 await screen.findByRole("button",{name:"开始导入"});
 expect(await screen.findByText("放到：保存库 / 具体目录")).toBeTruthy();
 expect(screen.getByRole("combobox",{name:"放到图库"}).textContent).toMatch(/^保存库/);
 expect(screen.getByRole("combobox",{name:"文件夹"}).textContent).toBe("具体目录");
});




it("running import does not claim that content is complete before the actual report", async () => {
  const receipt = { taskId: "publishing-B", destination: { libraryId: "B", folderId: null }, libraryName: "保存库", folderName: null, progress: { done: 47, total: 2000 }, finishing: true, warnings: [], report: null as null | { items: never[]; cancelled: boolean; fromEagle: boolean; eagleMissing: number; eagleRelocations: never[] } };
  fakeBackend({
    workspace_directories: { status: { revision: "test", libraries }, registrationOrder: [], providers: libraries.map(registration => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) },
    import_tasks: () => [{ ...receipt }],
  });
  render(<SaveDestinationProvider safe><ImportMenu enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} /></SaveDestinationProvider>);
  await screen.findByText("放到 保存库 / 未归类");
  expect(screen.queryByText("已导入，正在把标签信息存进图库…")).toBeNull();
  receipt.progress = { done: 2000, total: 2000 };
  receipt.report = { items: [], cancelled: false, fromEagle: false, eagleMissing: 0, eagleRelocations: [] };
  expect(await screen.findByText("已导入，正在把标签信息存进图库…")).toBeTruthy();
});

it("保存位置读取一直遇到“浏览结果已变化”时最多重试 3 次，然后显示问题", async () => {
 let calls = 0;
 fakeBackend({ workspace_directories: () => { calls++; return Promise.reject({ code: "cursorExpired" }); } });
 const { SaveDestinationPicker } = await import("./SaveDestination");
 render(<SaveDestinationProvider safe><SaveDestinationPicker value={null} onChange={() => {}} /></SaveDestinationProvider>);
 await waitFor(() => expect(screen.getByRole("status").textContent).toContain("浏览结果已变化"), { timeout: 3000 });
 await new Promise(resolve => setTimeout(resolve, 600));
 expect(calls).toBe(4);
});
