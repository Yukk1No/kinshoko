// PROTOTYPE（反馈 9 / Q8）：没有“当前图库”后，侧栏标题只剩“图库”和一个管理菜单。
import type { ComponentProps } from "react";
import { FolderOpen, FolderPlus, Plus, Settings2 } from "lucide-react";
import { LibraryPicker as Real } from "../../src/library/LibraryPicker";
import { Menu, MenuItem, MenuPopup } from "../../src/ui/Menu";

export function LibraryPicker(props: ComponentProps<typeof Real>) {
  const side = document.documentElement.dataset.side;
  if (side === "0" || props.layout === "inline") return <Real {...props} />;
  return <div className="proto-pane-title">
    <span>图库</span>
    <Menu.Root modal={false}>
      <Menu.Trigger className="k-icon-btn proto-lib-add" aria-label="打开、新建或管理图库" title="打开、新建或管理图库"><Plus size={15} /></Menu.Trigger>
      <MenuPopup width={200} label="图库">
        <MenuItem icon={<FolderOpen size={14} />}>打开图库…</MenuItem>
        <MenuItem icon={<FolderPlus size={14} />}>新建图库…</MenuItem>
        <MenuItem icon={<Settings2 size={14} />}>管理图库</MenuItem>
      </MenuPopup>
    </Menu.Root>
  </div>;
}
