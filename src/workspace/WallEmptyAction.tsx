import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { FileImage, FolderOpen } from "lucide-react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ImportControl } from "../library/ImportMenu";

/**
 * 图片墙空状态那句话后面的下一步：查找没有结果时清除条件；空图库直接给导入入口，
 * 不让新手先去找右上角的导入按钮。其他范围（文件夹、未归类、回收站）只有那句话。
 */
export function WallEmptyAction({
  searching,
  scope,
  importControl,
  onClearConditions,
}: {
  searching: boolean;
  scope: BrowseScope;
  importControl: RefObject<ImportControl | null>;
  onClearConditions: () => void;
}) {
  const { t } = useTranslation("workspace");
  if (searching) {
    return (
      <button type="button" className="k-btn" onClick={onClearConditions}>
        <span className="k-label">{t("empty.clearConditions")}</span>
      </button>
    );
  }
  if (scope.kind !== "all") return null;
  return (
    <div className="wall-empty-actions">
      <button type="button" className="k-btn is-primary" onClick={() => importControl.current?.files()}>
        <FileImage size={16} aria-hidden="true" />
        <span className="k-label">{t("empty.importFiles")}</span>
      </button>
      <button type="button" className="k-btn" onClick={() => importControl.current?.folder()}>
        <FolderOpen size={16} aria-hidden="true" />
        <span className="k-label">{t("empty.importFolder")}</span>
      </button>
    </div>
  );
}
