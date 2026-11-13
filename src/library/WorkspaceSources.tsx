import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import { useTranslation } from "react-i18next";
import { describeCommandError } from "../ipc/commandError";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { WorkspaceSourceEditor } from "./WorkspaceSourceEditor";
import { Segmented } from "../ui/Segmented";
import { useState } from "react";
import { libraryPathHint } from "./library-path";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

const keyOf = (source: WorkspaceSource) => source.libraryId + "/" + source.imageId;

/** 先打开卡片代表的那一份，它不可用时打开第一份可用的。 */
function firstSource(card: WorkspaceCard): WorkspaceSource | undefined {
  const usable = card.sources.filter((source) => !source.unavailable);
  return (
    usable.find((source) => source.libraryId === card.libraryId && source.imageId === card.imageId) ??
    usable[0] ??
    card.sources[0]
  );
}

/**
 * 详情面板里不在窗口打开的图库、或同一文件在 N 个图库各有一份整理的图（#98）：直接显示一份的详情；
 * 有多份时顶上用分段切换图库，标签、分级、文件夹与备注都只改所选的那一份。
 */
export function WorkspaceSources({
  card,
  onClose,
  safe = true,
  reloadKey = 0,
  registrations = [],
}: {
  card: WorkspaceCard;
  onClose: () => void;
  safe?: boolean;
  reloadKey?: number;
  registrations?: LibraryRegistration[];
}) {
  const { t } = useTranslation("inspector", { keyPrefix: "sources" });
  const [picked, setPicked] = useState<string | null>(null);
  const editing = card.sources.find((source) => keyOf(source) === picked) ?? firstSource(card);
  const root = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) =>
    root(id)
      ? libraryPathHint(
          root(id)!,
          registrations.map((r) => r.library.root),
        )
      : undefined;
  return (
    <section
      className="workspace-sources"
      aria-label={t("label")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {card.sources.length > 1 && (
        <Segmented
          label={t("picker")}
          value={editing ? keyOf(editing) : null}
          onChange={setPicked}
          options={card.sources.map((source) => ({
            value: keyOf(source),
            label: source.libraryName,
            disabled: !!source.unavailable,
            tip:
              [hint(source.libraryId), source.deleted ? t("trash") : null, source.unavailable ? t("offline") : null]
                .filter(Boolean)
                .join(t("titleSeparator")) || undefined,
          }))}
        />
      )}
      {editing?.unavailable ? (
        <p className="insp-hint" role="status">
          {describeCommandError(editing.unavailable)}
        </p>
      ) : (
        editing && (
          <WorkspaceSourceEditor
            key={keyOf(editing)}
            source={editing}
            safe={safe}
            reloadKey={reloadKey}
            onClose={onClose}
          />
        )
      )}
    </section>
  );
}
