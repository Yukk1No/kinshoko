// PROTOTYPE（反馈 9）：三种侧栏结构。前提（Q8 已定）：没有“当前图库”，每个图库的目录都可直接整理，
// 回收站跟随选中的图库；选“全部图片”时回收站合计各图库。只读、无拖动，只看结构。
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Images, Inbox, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { WorkspacePane as Real, WorkspaceSources } from "../../src/library/WorkspacePane";
import { workspaceDirectories } from "../../src/ipc";
import type { WorkspaceDirectories } from "../../src/bindings/WorkspaceDirectories";
import type { WorkspaceDirectory } from "../../src/bindings/WorkspaceDirectory";
import type { FolderNode } from "../../src/bindings/FolderNode";
import type { WorkspaceScope } from "../../src/bindings/WorkspaceScope";
import type { BrowseScope } from "../../src/bindings/BrowseScope";
import { Switch } from "../../src/ui/Switch";

export { WorkspaceSources };
type Props = ComponentProps<typeof Real>;

const sameLocal = (a: BrowseScope, b: BrowseScope) =>
  a.kind === b.kind && ((a.kind !== "folder" && a.kind !== "folderTree") || (b as { id: string }).id === a.id);
const isAt = (scope: WorkspaceScope, libraryId: string, local: BrowseScope) =>
  scope.kind === "library" && scope.libraryId === libraryId && sameLocal(scope.scope, local);

function Row({ icon, label, count, current, depth = 0, onClick, tail, muted }: {
  icon: ReactNode; label: ReactNode; count?: ReactNode; current?: boolean; depth?: number; onClick?: () => void; tail?: ReactNode; muted?: boolean;
}) {
  return <button type="button" className={`sidebar-item k-row proto-row-item${muted ? " is-muted" : ""}`} aria-current={current ? "page" : undefined}
    style={{ paddingLeft: 8 + depth * 14 }} onClick={onClick}>
    <span className="k-row-icon" aria-hidden="true">{icon}</span>
    <span className="sidebar-label">{label}</span>
    {tail}
    {count !== undefined && <span className="sidebar-count">{count}</span>}
  </button>;
}

function Tree({ nodes, lib, scope, onScope, depth }: { nodes: FolderNode[]; lib: string; scope: WorkspaceScope; onScope: (s: WorkspaceScope) => void; depth: number }) {
  return <>{nodes.map((n) => <div key={n.id}>
    <Row depth={depth} icon={n.children.length ? <FolderOpen size={15} /> : <Folder size={15} />} label={n.name} count={n.count}
      current={isAt(scope, lib, { kind: "folderTree", id: n.id }) || isAt(scope, lib, { kind: "folder", id: n.id })}
      onClick={() => onScope({ kind: "library", libraryId: lib, scope: { kind: "folderTree", id: n.id } })} />
    {n.children.length > 0 && <Tree nodes={n.children} lib={lib} scope={scope} onScope={onScope} depth={depth + 1} />}
  </div>)}</>;
}

/** 一个图库在树里的内容：全部、未归类、文件夹。 */
function LibraryBody({ p, scope, onScope, depth, showAll }: { p: WorkspaceDirectory; scope: WorkspaceScope; onScope: (s: WorkspaceScope) => void; depth: number; showAll?: boolean }) {
  const id = p.registration.library.id;
  if (!p.sidebar) return null;
  return <>
    {showAll && <Row depth={depth} icon={<Images size={15} />} label="这个图库的全部" count={p.sidebar.all}
      current={isAt(scope, id, { kind: "all" })} onClick={() => onScope({ kind: "library", libraryId: id, scope: { kind: "all" } })} />}
    <Row depth={depth} icon={<Inbox size={15} />} label="未归类" count={p.unassigned || undefined}
      current={isAt(scope, id, { kind: "unassigned" })} onClick={() => onScope({ kind: "library", libraryId: id, scope: { kind: "unassigned" } })} />
    <Tree nodes={p.sidebar.folders} lib={id} scope={scope} onScope={onScope} depth={depth} />
  </>;
}

function Offline({ p, onRecheck }: { p: WorkspaceDirectory; onRecheck?: () => void }) {
  return <div className="proto-offline" title={p.registration.unavailable ?? ""}>
    <span>未连接 · 移动盘接回后可用</span>
    <button type="button" onClick={onRecheck}><RefreshCw size={11} aria-hidden="true" />重新连接</button>
  </div>;
}

function Trash({ providers, scope, onScope }: { providers: WorkspaceDirectory[]; scope: WorkspaceScope; onScope: (s: WorkspaceScope) => void }) {
  const lib = scope.kind === "library" ? providers.find((p) => p.registration.library.id === scope.libraryId) : undefined;
  if (lib) {
    const id = lib.registration.library.id;
    return <Row icon={<Trash2 size={15} />} label={<>回收站<span className="proto-dim"> · {lib.registration.library.name}</span></>} count={lib.sidebar?.trash}
      current={isAt(scope, id, { kind: "trash" })} onClick={() => onScope({ kind: "library", libraryId: id, scope: { kind: "trash" } })} />;
  }
  const total = providers.reduce((n, p) => n + (p.sidebar?.trash ?? 0), 0);
  return <Row icon={<Trash2 size={15} />} label={<>回收站<span className="proto-dim"> · 全部图库</span></>} count={total} />;
}

function useForest(safeMode: boolean, key: unknown) {
  const [forest, setForest] = useState<WorkspaceDirectories | null>(null);
  useEffect(() => { void workspaceDirectories(safeMode).then(setForest); }, [safeMode, key]);
  return forest?.providers ?? [];
}

function Descendants({ scope, onScope }: { scope: WorkspaceScope; onScope: (s: WorkspaceScope) => void }) {
  const local = scope.kind === "library" ? scope.scope : null;
  const isFolder = local?.kind === "folder" || local?.kind === "folderTree";
  return <div className="sub-toggle workspace-descendants">
    <Switch size="sm" label="含子文件夹" checked={isFolder ? local.kind === "folderTree" : true} disabled={!isFolder}
      onCheckedChange={(c) => { if (isFolder && scope.kind === "library") onScope({ ...scope, scope: { kind: c ? "folderTree" : "folder", id: local.id } }); }} />
    <span aria-hidden="true">含子文件夹</span>
  </div>;
}

/** A：树即范围。图库是树的第一层，像 Finder 侧栏的分组；路径收进悬停提示，操作收进“⋯”。 */
function VariantA({ providers, scope, onScope, onRecheck, foot, accordion }: Props & { providers: WorkspaceDirectory[]; accordion?: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // D：选中哪个图库就只展开哪个；选“全部图片”时全部折起。手动点箭头仍可临时展开。
  const selectedLib = scope.kind === "library" ? scope.libraryId : null;
  useEffect(() => { if (accordion) setCollapsed(new Set(providers.map((p) => p.registration.library.id).filter((id) => id !== selectedLib))); }, [accordion, selectedLib, providers.length]);
  const total = providers.reduce((n, p) => n + (p.sidebar?.all ?? 0), 0);
  return <nav className="workspace-scope side-bands proto-side-a" aria-label="查找范围">
    <div className="side-top">
      <Row icon={<Images size={15} />} label="全部图片" count={total} current={scope.kind === "all"} onClick={() => onScope({ kind: "all" })} />
    </div>
    <div className="side-scroll">
      {providers.map((p) => {
        const { id, name, root } = p.registration.library;
        const open = !collapsed.has(id) && !p.registration.unavailable;
        return <section key={id} className="proto-lib">
          <div className="proto-lib-head" title={root}>
            <button type="button" className="proto-chev" aria-label={open ? "收起" : "展开"} onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <button type="button" className="proto-lib-name" aria-current={isAt(scope, id, { kind: "all" }) ? "page" : undefined}
              disabled={!!p.registration.unavailable} onClick={() => onScope({ kind: "library", libraryId: id, scope: { kind: "all" } })}>
              <span className="sidebar-label">{name}</span>
              {p.registration.unavailable ? <span className="proto-off-dot" aria-label="未连接" /> : <span className="sidebar-count">{p.sidebar?.all}</span>}
            </button>
            <button type="button" className="proto-more k-icon-btn" aria-label={`${name} 的操作`} title="新建文件夹、在资源管理器中打开、从列表移除"><MoreHorizontal size={14} /></button>
          </div>
          {p.registration.unavailable && <Offline p={p} onRecheck={onRecheck} />}
          {open && <LibraryBody p={p} scope={scope} onScope={onScope} depth={1} />}
        </section>;
      })}
      <Descendants scope={scope} onScope={onScope} />
    </div>
    <div className="side-foot">{foot}<Trash providers={providers} scope={scope} onScope={onScope} /></div>
  </nav>;
}

/** B：一次只展开一个图库。图库是一列平级的范围，选中哪个就在原地展开哪个的目录，其余折成一行。 */
function VariantB({ providers, scope, onScope, onRecheck, foot }: Props & { providers: WorkspaceDirectory[] }) {
  const total = providers.reduce((n, p) => n + (p.sidebar?.all ?? 0), 0);
  const openId = scope.kind === "library" ? scope.libraryId : null;
  return <nav className="workspace-scope side-bands proto-side-b" aria-label="查找范围">
    <div className="side-scroll">
      <div className="proto-scope-list">
        <button type="button" className="proto-scope" aria-current={scope.kind === "all" ? "page" : undefined} onClick={() => onScope({ kind: "all" })}>
          <span className="proto-scope-mark is-all"><Images size={14} /></span>
          <span className="proto-scope-text"><b>全部图片</b><small>{providers.length} 个图库</small></span>
          <span className="sidebar-count">{total}</span>
        </button>
        {providers.map((p) => {
          const { id, name, root } = p.registration.library;
          const open = openId === id;
          return <div key={id} className={`proto-scope-group${open ? " is-open" : ""}`}>
            <button type="button" className="proto-scope" title={root} disabled={!!p.registration.unavailable}
              aria-current={isAt(scope, id, { kind: "all" }) ? "page" : undefined} aria-expanded={open}
              onClick={() => onScope({ kind: "library", libraryId: id, scope: { kind: "all" } })}>
              <span className="proto-scope-mark">{name.slice(0, 1)}</span>
              <span className="proto-scope-text"><b>{name}</b><small>{p.registration.unavailable ? "未连接" : `${p.sidebar?.folders.length ?? 0} 个文件夹`}</small></span>
              <span className="sidebar-count">{p.registration.unavailable ? "" : p.sidebar?.all}</span>
            </button>
            {p.registration.unavailable && <Offline p={p} onRecheck={onRecheck} />}
            {open && <div className="proto-scope-body"><LibraryBody p={p} scope={scope} onScope={onScope} depth={0} /></div>}
          </div>;
        })}
      </div>
      {openId && <Descendants scope={scope} onScope={onScope} />}
    </div>
    <div className="side-foot">{foot}<Trash providers={providers} scope={scope} onScope={onScope} /></div>
  </nav>;
}

/** C：顶部一条图库切换条（含“全部”），下面只放所选图库的目录；选“全部”时下面是各图库的概览。 */
function VariantC({ providers, scope, onScope, onRecheck, foot }: Props & { providers: WorkspaceDirectory[] }) {
  const selected = scope.kind === "library" ? providers.find((p) => p.registration.library.id === scope.libraryId) : undefined;
  const total = providers.reduce((n, p) => n + (p.sidebar?.all ?? 0), 0);
  return <nav className="workspace-scope side-bands proto-side-c" aria-label="查找范围">
    <div className="proto-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={scope.kind === "all"} onClick={() => onScope({ kind: "all" })}>全部</button>
      {providers.map((p) => <button key={p.registration.library.id} type="button" role="tab" title={p.registration.library.root}
        aria-selected={selected === p} className={p.registration.unavailable ? "is-off" : ""}
        onClick={() => onScope({ kind: "library", libraryId: p.registration.library.id, scope: { kind: "all" } })}>{p.registration.library.name}</button>)}
    </div>
    <div className="side-scroll">
      {!selected && <>
        <p className="proto-overview-head">全部图片 · {total} 张，来自 {providers.length} 个图库</p>
        <div className="proto-overview">
          {providers.map((p) => <button key={p.registration.library.id} type="button" className="proto-card" title={p.registration.library.root}
            onClick={() => onScope({ kind: "library", libraryId: p.registration.library.id, scope: { kind: "all" } })}>
            <b>{p.registration.library.name}</b>
            <span>{p.registration.unavailable ? "未连接" : `${p.sidebar?.all} 张 · ${p.sidebar?.folders.length} 个文件夹`}</span>
          </button>)}
        </div>
      </>}
      {selected && <>
        {selected.registration.unavailable ? <Offline p={selected} onRecheck={onRecheck} />
          : <LibraryBody p={selected} scope={scope} onScope={onScope} depth={0} showAll />}
        <Descendants scope={scope} onScope={onScope} />
      </>}
    </div>
    <div className="side-foot">{foot}<Trash providers={providers} scope={scope} onScope={onScope} /></div>
  </nav>;
}

export function WorkspacePane(props: Props) {
  const side = document.documentElement.dataset.side ?? "0";
  const providers = useForest(props.safeMode, props.status?.revision);
  if (side === "0") return <Real {...props} />;
  if (side === "D") return <VariantA {...props} providers={providers} accordion />;
  const V = side === "A" ? VariantA : side === "B" ? VariantB : VariantC;
  return <V {...props} providers={providers} />;
}
