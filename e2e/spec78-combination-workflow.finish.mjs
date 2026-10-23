// CombinationWorkflow methods for late picker, import ownership, runtime/update UI and receipt consent; spec78-combination-workflow.mjs mixes them into the class.
import { until } from "./spec78-combination-driver.mjs";
import { literal, dialog } from "./spec78-combination-workflow.xpath.mjs";

export const finishPhases = {
  async latePickerAndRules() {
    this.phase("real-monitor-picker-and-personal-rule"); const d=this.d;
    await this.settings("标签");await this.tagView("分组");await d.events(["workspace-changed","library-event"]);
    const section="//section[@aria-label='全局标签分组']";
    await this.readyClick(`${section}//button[@aria-label='新建标签分组']`);
    await d.type(`${section}//input[@aria-label='新标签分组名称']`,"跨库眼睛");await this.readyClick(`${section}//button[normalize-space()='建立']`);
    const afterCreation=await d.invoke("workspace_status",{safeMode:true});
    await until("real monitor settles the actual group creation",async()=>(await d.readEvents()).some(event=>event.payload.event==="workspace-changed"&&event.payload.payload.revision===afterCreation.revision));
    await this.readyClick(`${section}//button[@aria-label='给“跨库眼睛”加标签']`);
    await d.type(`${section}//input[@aria-label='挑一个统一标签']`,"最贴切");
    const typedAt=await d.exec("window.__T20_PICKER_NODE__=document.querySelector('section[aria-label=全局标签分组] input[aria-label=挑一个统一标签]');return Date.now();");
    d.assert(await d.exec("const node=window.__T20_PICKER_NODE__;return node?.value==='最贴切'&&node===document.activeElement;"),"the real tag picker is focused and contains input before the catalog change",{typedAt});
    const beforeMutation=await d.invoke("workspace_status",{safeMode:true});
    const monitorAlias={lang:"zh-CN",name:"本轮监视器触发的分发别名"};
    await d.invoke("edit_tag_name",{catalogId:this.parted,edit:{kind:"addAlias",alias:monitorAlias}});
    const afterMutation=await d.invoke("workspace_status",{safeMode:true});
    d.assert(afterMutation.revision!==beforeMutation.revision,"a real unrelated catalog alias changes the workspace after picker input",{beforeMutation,afterMutation,monitorAlias});
    const late=await until("actual changed revision arrives after typing",async()=>(await d.readEvents()).find(event=>event.payload.event==="workspace-changed"&&event.payload.payload.revision===afterMutation.revision&&event.at>typedAt));
    await until("fresh actual candidate after monitor refresh",()=>d.exec("const field=document.querySelector('section[aria-label=全局标签分组] input[aria-label=挑一个统一标签]');return field?.value==='最贴切'&&field===window.__T20_PICKER_NODE__&&field===document.activeElement&&document.querySelector('section[aria-label=全局标签分组] .sidebar-pick-tag [role=option]')?.textContent.includes('最贴切的蓝瞳');"));
    d.assert(true,"real post-input catalog notification preserves the same focused tag picker and typed input",{typedAt,late,monitorAlias});
    await d.key("\uE007");
    const group=await until("preserved picker commits a real member",async()=>(await d.invoke("shared_tag_groups",{lang:"zh-CN",safeMode:true})).find(group=>group.name==="跨库眼睛"&&group.tags.some(member=>member.tag.id===this.blue)));
    this.sharedGroup=group.id;
    await d.invoke("edit_shared_tag_group",{edit:{kind:"addMembers",groupId:group.id,tagIds:[this.aqua]},safeMode:true});
    await until("committed member rendered in the same group editor",()=>d.exec("const group=[...document.querySelectorAll('section[aria-label=全局标签分组] [role=group]')].find(node=>node.getAttribute('aria-label')==='跨库眼睛');return !!group&&group.textContent.includes('最贴切的蓝瞳');"));
    await d.screenshot("04-preserved-picker-and-live-global-settings.png");
    await d.invoke("edit_shared_approx",{edit:{kind:"set",rules:[{a:this.blue,b:this.aqua,relation:"similar"}]},safeMode:true});
    // Personal rules live on the 相近 view of the same 标签 tab.
    await this.tagView("相近");
    await until("actual personal rule table has completed loading",()=>d.exec("const table=document.querySelector('table[aria-label=相近标签表]');return table?.textContent.includes('最贴切的蓝瞳')&&table.textContent.includes('水色瞳')&&!document.querySelector('section[aria-label=相近标签]')?.textContent.includes('正在读取相近标签…');"));
    await d.screenshot("04b-live-global-personal-rule.png");await this.closeSettings();
    this.state.shared={groupId:this.sharedGroup,blue:this.blue,aqua:this.aqua,parted:this.parted,typedAt,late,afterCreation,beforeMutation,afterMutation,monitorAlias};this.save();
  },
  async fixedImportOwner() {
    this.phase("running-import-owner-vs-browse-current-next-save");const d=this.d;
    await this.current(this.a.id);await this.clearSearch();await this.scope(this.a.id,this.folderA);
    const id=await this.beginImport(Array(this.fixture.longImportCount).fill(this.fixture.inputs.incoming.path),this.b.id,this.folderB);
    const running=await until("genuinely pending partially progressed import",async()=>{const task=await this.task(id);return task&&!task.report&&task.progress.done>0&&task.progress.done<task.progress.total?task:null;});
    await this.current(this.b.id);await this.scope(this.a.id,this.folderA);
    // #98: while an import runs, the import dialog cannot open, so the shared next-save target is
    // changed by a real save into A/folderA through the same destination dialog (导入参考组包).
    const nextSave=await this.importPackage(this.a.id,this.folderA);
    d.assert(nextSave.members.length>0&&nextSave.members.every(member=>member.libraryId===this.a.id),"a real save during the running task goes to the newly chosen next-save A",nextSave);
    await this.scope(this.a.id,this.folderA);
    const during=await this.task(id);
    d.assert(during&&!during.report&&during.destination.libraryId===this.b.id&&during.destination.folderId===this.folderB,"actual pending task retains B while current B, browsing A and next-save A differ",{before:running,during,nextSave:{groupId:nextSave.id,members:nextSave.members}});
    d.assert(await d.exec("const card=document.querySelector('section[aria-label=导入进度]');return !!card&&card.getClientRects().length>0&&card.textContent.includes('放到 同名资料库 / 同名目录');"),"visible running receipt reports the fixed original provider and folder");
    d.assert(await d.invoke("cancel_import",{libraryId:this.a.id,taskId:id}).then(()=>false,()=>true),"a real pending task rejects cancellation through the wrong provider");
    await d.screenshot("05-fixed-owner-with-independent-browse-and-save.png");
    // r3 observed ~14 entries/s for this 2000-entry debug-build task; 90s was a harness bound, not a product limit.
    const completed=await this.finish(id,900000);this.receipts.push(completed);
    d.assert(!completed.report.cancelled&&completed.report.items.length===this.fixture.longImportCount,"same task completes every submitted entry after current, scope and next-save changes",completed);
    const source=async(libraryId)=>(await this.local(libraryId)).cards.find(card=>card.width===this.fixture.inputs.incoming.width&&card.height===this.fixture.inputs.incoming.height);
    d.assert(await source(this.b.id)&&!await source(this.a.id),"incoming original exists only in submitted B, never in browse/next-save A");
    await this.current(this.a.id);this.state.runningImport={before:running,during,completed,nextSave:{groupId:nextSave.id,via:"导入参考组包",members:nextSave.members}};this.save();
  },
  async runtimeAndUpdateUI() {
    this.phase("actual-runtime-diagnostics-and-manual-update-ui");const d=this.d;
    // 本机运行时 is now 设置 › 诊断 › 运行环境; the recheck button is 检查 and success is the 正常 status.
    await this.settings("诊断");
    const section="//section[@aria-label='运行环境']";
    await this.readyClick(`${section}//button[normalize-space()='检查']`);
    await until("actual current-window capability check settled",()=>d.exec("const node=document.querySelector('section[aria-label=运行环境]');return node&&!node.textContent.includes('检查中')&&node.textContent.includes('正常')&&!node.querySelector('[role=alert]')&&!node.querySelector('button:disabled');"));
    await d.exec("document.querySelector('section[aria-label=运行环境]').scrollIntoView({block:'center'});");
    const runtime=await d.exec("const node=document.querySelector('section[aria-label=运行环境]');return {text:node.textContent,rect:node.getBoundingClientRect().toJSON()};");
    d.assert(/WebView2 [0-9]+\./.test(runtime.text)&&runtime.text.includes("不代表颜色还原已通过"),"actual WebView2 and current-window capability results retain the separate color-quality boundary",runtime);
    await d.screenshot("10b-actual-runtime-capabilities.png");
    await this.readyClick("//section[@aria-label='设置']//*[normalize-space()='诊断信息']/ancestor::*[.//button[normalize-space()='查看']][1]//button[normalize-space()='查看']");
    const diagnostics=await until("real diagnostics contain actual decoding and drawing checks",()=>d.exec("const text=document.querySelector('pre[aria-label=诊断信息]')?.textContent;return text?.includes('内置 PNG 解码：完成')&&text.includes('钉图二维绘制与基础像素读回：完成')?text:null;"));
    // Scroll the real text range; keep both ends of the capabilities block inside each actual clip.
    const expose="const pre=document.querySelector('pre[aria-label=诊断信息]'),text=pre.textContent,start=text.indexOf('[运行时能力]'),end=text.indexOf('[显示器]',start);if(start<0||end<0)throw Error('actual capability section missing');const range=document.createRange();range.setStart(pre.firstChild,start);range.setEnd(pre.firstChild,end);pre.scrollIntoView({block:'center'});const before=range.getBoundingClientRect(),box=pre.getBoundingClientRect();pre.scrollTop+=(before.top+before.bottom-box.top-box.bottom)/2;return true;";
    await d.exec(expose);
    const diagnosticVisibility=await until("whole actual capability text block visible",()=>d.exec("const pre=document.querySelector('pre[aria-label=诊断信息]'),text=pre.textContent,start=text.indexOf('[运行时能力]'),end=text.indexOf('[显示器]',start),range=document.createRange();range.setStart(pre.firstChild,start);range.setEnd(pre.firstChild,end);const rect=range.getBoundingClientRect();let top=0,bottom=innerHeight,left=0,right=innerWidth;for(let node=pre;node;node=node.parentElement){const style=getComputedStyle(node),box=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}}return rect.top>=top&&rect.bottom<=bottom&&rect.left>=left&&rect.right<=right?{range:rect.toJSON(),clip:{top,bottom,left,right},text:text.slice(start,end)}:null;"));
    d.save("actual-diagnostics.json",{text:diagnostics,visibility:diagnosticVisibility});await d.screenshot("10c-actual-diagnostics-visible-capability-block.png");
    const update=await d.invoke("update_status",{},null);
    d.assert(update.state==="manual"&&update.message==="当前使用安装包手动更新。","the actual build reports manual package updating without a repository-visibility claim",update);
    // 设置 › 更新: the manual steps are behind 查看步骤.
    await this.settings("更新");
    await this.readyClick("//section[@aria-label='设置']//button[normalize-space()='查看步骤']");
    const updateUI=await until("actual complete manual update instructions visibly rendered",()=>d.exec(`
const message=[...document.querySelectorAll('section[aria-label=设置] p')].find(node=>node.textContent.trim()===arguments[0]),steps=message?.nextElementSibling;
if(!steps?.textContent.includes('从托盘退出 Kinshoko 后，运行开发者提供的新版安装包'))return null;
steps.scrollIntoView({block:'center'});
const a=message.getBoundingClientRect(),b=steps.getBoundingClientRect(),whole={top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom),left:Math.min(a.left,b.left),right:Math.max(a.right,b.right)};
let top=0,bottom=innerHeight,left=0,right=innerWidth;
for(let node=message.parentElement;node;node=node.parentElement){const style=getComputedStyle(node),box=node.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}}
if(whole.top<top||whole.bottom>bottom||whole.left<left||whole.right>right)return null;
return {message:message.textContent,steps:steps.textContent,visibility:{whole,clip:{top,bottom,left,right},message:a.toJSON(),steps:b.toJSON()},buttons:[...document.querySelectorAll('section[aria-label=设置] button')].map(node=>node.textContent.trim())};
`,[update.message]));
    d.assert(!updateUI.buttons.includes("检查更新")&&!updateUI.buttons.includes("安装并重启")&&updateUI.steps.includes("安装到原位置")&&updateUI.steps.includes("继续使用已有图库、设置、参考组和钉图"),"formal settings show the complete supported manual-update steps",updateUI);
    await d.screenshot("10d-manual-update-instructions.png");
    await this.closeSettings();this.state.runtimeAndUpdate={runtime,diagnosticVisibility,update,updateUI,colorGate:"independent-existing-results-unchanged"};this.save();
  },
  async strictAdultAndConsent() {
    this.phase("strict-known-adult-and-receipt-consent");const d=this.d;
    await d.invoke("workspace_edit_source",{target:this.sealedB,safeMode:true,edits:[{kind:"setRating",rating:"explicit"}]});
    const a=await this.local(this.a.id),b=await this.local(this.b.id),all=await this.allPages();
    d.assert(!a.cards.some(card=>card.id===this.sealedA.contentId)&&!b.cards.some(card=>card.id===this.sealedA.contentId)&&!all.cards.some(card=>card.id===this.sealedA.contentId),"known Adult B vetoes byte-identical Unknown A even in A-only scope",{a:a.total,b:b.total,all:all.total,sealed:this.sealedA.contentId});
    d.assert(a.cards.some(card=>card.width===this.fixture.inputs.unknown.width&&card.height===this.fixture.inputs.unknown.height),"an unrelated genuinely Unknown control stays visible");
    d.assert(await this.inspect(this.sealedA).then(()=>false,()=>true),"hidden Unknown A cannot be opened through a stale aggregate source target");
    await this.scope(this.a.id,this.folderA);const receipt=await this.import([this.fixture.inputs.sealed.path],this.a.id,this.folderA);
    d.assert(receipt.report.sealedDuplicates&&receipt.report.privateSummary&&receipt.report.items.length===0&&receipt.progress.done===0&&receipt.progress.total===0,"default real sealed receipt conceals successful item IDs and exact counts",receipt);
    // The sealed prompt is a bottom-right card with #78's literal wording “有封印项重复，是否展开看看” and 展开.
    // The preview re-veils on any workspace change by design; let the import's change burst end first.
    await this.settled();
    await until("actual sealed consent prompt",()=>d.exec("const card=document.querySelector('section[aria-label=封印项重复]');return !!card&&card.getClientRects().length>0&&card.textContent.includes('有封印项重复，是否展开看看')&&!/成人/.test(card.textContent);"));
    d.assert(!await d.exec("return !!document.querySelector('[role=dialog].sealed-import-preview');"),"no sealed preview exists before explicit consent");
    await d.screenshot("06-default-scoped-sealed-prompt.png");
    await this.readyClick("//section[@aria-label='封印项重复']//button[@aria-label='展开本次重复项']");
    await until("actual one receipt duplicate decoded",()=>d.exec("const images=[...document.querySelectorAll('[role=dialog].sealed-import-preview img')];return images.length===1&&images[0].complete&&images[0].naturalWidth>0;"));
    d.assert(await d.invoke("safe_mode")===true,"receipt-scoped consent keeps global safe mode on");
    await d.screenshot("07-one-receipt-consent.png");
    // The preview is a modal Base UI dialog: nothing behind it can be clicked. As the old harness did with a JS
    // select change, change the current library with synthetic events on the library menu behind the modal.
    await this.currentBehindModal(this.b.id);
    await until("current provider change re-veils decoded preview",()=>d.exec("return !document.querySelector('[role=dialog].sealed-import-preview');"));
    await this.shownCurrent(this.b.id);
    await this.current(this.a.id);
    d.assert(!await d.exec("return !!document.querySelector('[role=dialog].sealed-import-preview img');"),"returning to A requires fresh consent instead of reviving decoded content");
    this.sealedReceipt=receipt;this.state.sealed={receipt};this.save();
  }
};
