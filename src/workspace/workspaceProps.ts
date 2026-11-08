import type { ReactNode } from "react";
import type { Section } from "../shell/Rail";

/** 工作区（LibraryWorkspace）的属性。 */
export type WorkspaceProps = {
  captureRequest?:{id:string;stamp:number}|null;
  onCaptureRequestHandled?:()=>void;
  /** 钉图菜单“在 Kinshoko 中打开”的参考图（#106）：在查看器里打开。 */
  referenceRequest?: { libraryId: string; imageId: string; stamp: number } | null;
  section: Section;
  paneOpen: boolean;
  onPaneToggle: () => void;
  /** 窄窗口里自动收起、恢复侧栏，以及点开浮起的侧栏后收回。 */
  onPaneOpen: (open: boolean) => void;
  onOpenBrowse: () => void;
  libraryControls: ReactNode;
  /** 新建资料库表单打开时只隐藏工作区，继续接收导入事件。 */
  hidden: boolean;
  /** 查询资料库用的安全模式视角：开启当即生效，关闭等后端确认（#183）。 */
  safe: boolean;
  /** 资料库确认安全模式已切换（`safeModeChanged`）。 */
  onSafeChanged: (on: boolean) => void;
  showApproxSource: boolean;
  /** 设置“切换安全模式时保留选择”；关闭时切换即清空选择和来源面板。 */
  keepSelectionOnSafe: boolean;
  /** 本设备保存的详情面板宽度（#157）；没拖过时为 undefined。 */
  inspectorWidth?: number;
  /** 拖动松手、双击或方向键定下的详情面板宽度。 */
  onInspectorWidth: (width: number) => void;
  /** 详情面板是否打开：本设备记住，只由画师亲手开合。 */
  inspectorShown: boolean;
  onInspectorShown: (open: boolean) => void;
  /** 顶栏下方的提示（运行时、旧名称、更新、备份提醒）。 */
  /** 侧栏图库标题菜单“从列表移除”之后（#114）。 */
  onLibraryRemoved?: (libraryId: string) => void;
  /** 侧栏移除图库后点“撤销”：按原位置重新登记。 */
  onLibraryRestore?: (root: string) => Promise<void>;
  /** 点打标图标：打开设置 › 自动标签（#144）。 */
  onOpenTaggingSettings: () => void;
};
