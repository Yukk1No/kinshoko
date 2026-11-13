import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { SettingsPanel } from "../settings/SettingsPanel";
import type { TagLabel } from "../bindings/TagLabel";
const label=(id:string,name:string):TagLabel=>({id,name,namespace:"general",untranslated:false,hasExternal:false});
it("lists and deletes application rules without an active library",async()=>{
  let entries=[{a:label("blue","蓝瞳"),b:label("sky","天空色"),relation:"similar",sources:[]}];
  const fake=fakeBackend({
    workspace_status:{revision:"r1",libraries:[]},
    shared_personal_approx:()=>({revision:1,entries,conflicts:[]}),
    edit_shared_approx:()=>{entries=[];return null;},
  });
  render(<SettingsPanel initialTab="tags"/>);fireEvent.click(await screen.findByRole("button",{name:"相近"}));
  const table=await screen.findByRole("table",{name:"相近标签表"});
  expect(within(table).getByText(/蓝瞳/)).toBeTruthy();
  fireEvent.click(within(table).getByRole("button",{name:"删除"}));
  await waitFor(()=>expect(screen.queryByRole("table",{name:"相近标签表"})).toBeNull());
  expect(fake.calls("edit_shared_approx")[0]?.args).toEqual({edit:{kind:"remove",a:"blue",b:"sky"},safeMode:true});
});

import { SearchBox } from "./SearchBox";
it("workspace search saves forever using shared IDs and preserves once as current input",async()=>{
  const changes:unknown[]=[];
  const fake=fakeBackend({edit_shared_approx:null});
  const blue=label("shared-blue","蓝瞳"),aqua=label("shared-aqua","水色瞳");
  render(<SearchBox workspace libraryId="currently-browsed-B" safe generation={1} input={{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[]}],negate:false}],exact:false}} tree={{conditions:[{any:[{kind:"tag",tag:blue,similar:[{tag:aqua,source:"builtin",of:[blue.id]}]}],negate:false}]}} showSource={false} onChange={value=>changes.push(value)} onError={error=>{throw Error(String(error));}}/>);
  fireEvent.click(screen.getByRole("button",{name:"不带“水色瞳”的相近标签"}));
  fireEvent.click(await screen.findByRole("menuitem",{name:"只这次"}));
  expect(changes).toEqual([{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[aqua.id]}],negate:false}],exact:false}]);
  expect(fake.calls("edit_shared_approx")).toEqual([]);
  fireEvent.click(screen.getByRole("button",{name:"不带“水色瞳”的相近标签"}));
  fireEvent.click(await screen.findByRole("menuitem",{name:"以后都不带"}));
  await waitFor(()=>expect(fake.calls("edit_shared_approx")[0]?.args).toEqual({edit:{kind:"set",rules:[{a:blue.id,b:aqua.id,relation:"notSimilar"}]},safeMode:true}));
});

import { emit } from "@tauri-apps/api/event";
import { fakeBackend } from "../test/backend";
it("shows legacy disagreement as pending and submits an explicit conflict choice",async()=>{
  const conflict={a:label("blue","蓝瞳"),b:label("aqua","水色瞳"),current:null,sources:[{libraryId:"A",libraryName:"同名库",libraryRoot:"D:/A",relation:"similar"},{libraryId:"B",libraryName:"同名库",libraryRoot:"E:/B",relation:"notSimilar"}]};
  const fake=fakeBackend({workspace_status:{revision:"r1",libraries:[]},shared_personal_approx:{revision:7,entries:[],conflicts:[conflict]},edit_shared_approx:null});
  render(<SettingsPanel initialTab="tags"/>);fireEvent.click(await screen.findByRole("button",{name:"相近"}));
  const group=await screen.findByRole("group",{name:"相近判断冲突"});
  expect(group.textContent).toContain("较早图库的判断不一致");expect(group.textContent).not.toMatch(/规则|全局/);expect(group.textContent).toContain("D:/A");expect(group.textContent).toContain("E:/B");
  const keep=within(group).getByRole("button",{name:"保持现状"});expect(keep.className).toContain("k-btn");
  fireEvent.click(keep);
  await waitFor(()=>expect(fake.calls("edit_shared_approx")[0]?.args).toEqual({edit:{kind:"resolveConflict",a:"blue",b:"aqua",revision:7,relation:null},safeMode:true}));
});
it("does not release a late unsafe rule list after safe mode changes",async()=>{
  let resolveOld:(value:unknown)=>void=()=>{};
  let oldStarted=false;
  const old=new Promise(resolve=>{resolveOld=resolve;});
  fakeBackend({safe_mode:false,workspace_status:{revision:"r1",libraries:[]},shared_personal_approx:(args)=>{if((args as {safeMode:boolean}).safeMode)return {revision:2,entries:[],conflicts:[]};oldStarted=true;return old;}});
  render(<SettingsPanel initialTab="tags"/>);fireEvent.click(await screen.findByRole("button",{name:"相近"}));
  await screen.findByRole("switch",{name:"标出来源"});
  await waitFor(()=>expect(oldStarted).toBe(true));
  await act(async()=>{await emit("safe-mode-setting",true);});
  await act(async()=>{resolveOld({revision:1,entries:[{a:label("secret","封印旧标签"),b:label("other","另一标签"),relation:"similar",sources:[]}],conflicts:[]});await old;});
  expect(screen.queryByText(/封印旧标签/)).toBeNull();
});
it("workspace plus chooses an unmapped visible tag and saves one global rule",async()=>{
  const sky=label("shared-sky","天空色"),blue=label("shared-blue","蓝瞳");
  const fake=fakeBackend({workspace_candidates:[{tag:sky,via:null,count:1}],edit_shared_approx:null});
  render(<SearchBox workspace libraryId="B" safe generation={1} input={{conditions:[{any:[{kind:"tag",id:blue.id,dismissed:[]}],negate:false}],exact:false}} tree={{conditions:[{any:[{kind:"tag",tag:blue,similar:[]}],negate:false}]}} showSource={false} onChange={()=>{}} onError={error=>{throw Error(String(error));}}/>);
  fireEvent.click(screen.getByRole("button",{name:"给“蓝瞳”加相近标签"}));
  fireEvent.change(await screen.findByRole("combobox",{name:"挑一个标签"}),{target:{value:"天空"}});
  fireEvent.click(await screen.findByRole("option",{name:/天空色/}));
  await waitFor(()=>expect(fake.calls("edit_shared_approx")[0]?.args).toEqual({edit:{kind:"set",rules:[{a:blue.id,b:sky.id,relation:"similar"}]},safeMode:true}));
});
