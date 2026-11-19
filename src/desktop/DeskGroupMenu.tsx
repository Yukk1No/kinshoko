import { useTranslation } from "react-i18next";
import { Copy, Eraser, PackageOpen, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import { MenuItem, MenuSeparator } from "../ui/Menu";

/**
 * 参考组卡片的菜单项（#592）：“⋯”与卡片的右键菜单是同一组（设计系统“图库标题的 ⋯”一行）。
 * 读不懂的参考组只能删除；危险项置底、红字。
 */
export function DeskGroupMenuItems({
  usable,
  favorite,
  onDesk,
  canPrune,
  onRename,
  onFavorite,
  onCopy,
  onPrune,
  onExport,
  onDelete,
}: {
  usable: boolean;
  favorite: boolean;
  onDesk: boolean;
  canPrune: boolean;
  onRename: () => void;
  onFavorite: (favorite: boolean) => void;
  onCopy: () => void;
  onPrune: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("desktop");
  return (
    <>
      {usable && (
        <>
          <MenuItem icon={<Pencil size={14} />} onClick={onRename}>
            {t("groups.rename")}
          </MenuItem>
          <MenuItem icon={favorite ? <StarOff size={14} /> : <Star size={14} />} onClick={() => onFavorite(!favorite)}>
            {t(favorite ? "deskPanel.unfavorite" : "deskPanel.favorite")}
          </MenuItem>
          <MenuItem icon={<Copy size={14} />} onClick={onCopy}>
            {t("deskPanel.copy")}
          </MenuItem>
          {onDesk && (
            <MenuItem icon={<Eraser size={14} />} disabled={!canPrune} onClick={onPrune}>
              {t("deskPanel.prune")}
            </MenuItem>
          )}
          <MenuItem icon={<PackageOpen size={14} />} onClick={onExport}>
            {t("groups.export")}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem icon={<Trash2 size={14} />} danger onClick={onDelete}>
        {t("groups.delete")}
      </MenuItem>
    </>
  );
}
