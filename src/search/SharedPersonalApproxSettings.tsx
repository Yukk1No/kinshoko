import { useEffect, useRef, useState } from "react";
import type { CatalogApproxEdit } from "../bindings/CatalogApproxEdit";
import type { CatalogApproxView } from "../bindings/CatalogApproxView";
import { editSharedApprox, isLensChanged, sharedPersonalApprox } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { libraryPathHint } from "../library/library-path";
import { useSafeModeSetting } from "../shell/useShellSettings";
import { workspaceStatusKey, workspaceStatusMirror } from "../workspace/workspaceStatusMirror";
import { TagMarks, tagName } from "./SearchBox";
import { useUiLang } from "../i18n";
import { i18n } from "../i18n/instance";
import { useTranslation } from "react-i18next";
import { Tip } from "../ui/Tip";

const relationName = (relation: string) =>
  i18n.t(relation === "similar" ? "tagSettings:approx.similar" : "tagSettings:approx.notSimilar");

const approxKey = (lang: string, safe: boolean, safeGeneration: number, revision: string | null) =>
  JSON.stringify([lang, safe, safeGeneration, revision]);
const readApproxKey = (key: string): [string, boolean] => {
  const [lang, safe] = JSON.parse(key) as [string, boolean, number, string];
  return [lang, safe];
};

/** 个人近似对应表的应用级镜像。查询键含界面语言、安全模式视角/代次与工作区修订；修订变化由工作区镜像换成新键。 */
const sharedPersonalApproxMirror = createBackendMirror<string, CatalogApproxView>({
  read: (key) => {
    const [lang, safe] = readApproxKey(key);
    return sharedPersonalApprox(lang, safe);
  },
  stale: isLensChanged,
});

/** Same formal settings structure, with stable shared identities and source-aware conflict choices. */
export function SharedPersonalApproxSettings({ onError }: { onError: (error: unknown) => void }) {
  const safeMode = useSafeModeSetting();
  const safe = safeMode.value?.on ?? null;
  const safeGeneration = safeMode.value?.generation ?? 0;
  const [pending, setPending] = useState<string | null>(null);
  const lang = useUiLang();
  const { t } = useTranslation("tagSettings", { keyPrefix: "approx" });
  const workspace = useBackendMirror(workspaceStatusMirror, workspaceStatusKey(safe ?? true), safe !== null);
  const revision = workspace.value?.revision ?? null;
  const key = approxKey(lang, safe ?? true, safeGeneration, revision);
  const found = useBackendMirror(sharedPersonalApproxMirror, key, safe !== null && revision !== null);
  const view = safe === null || revision === null ? null : found.value;
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (safeMode.error !== null) onErrorRef.current(safeMode.error);
  }, [safeMode.error]);
  useEffect(() => {
    if (workspace.error !== null && !isLensChanged(workspace.error)) onErrorRef.current(workspace.error);
  }, [workspace.error]);
  useEffect(() => {
    if (found.error !== null && !isLensChanged(found.error)) onErrorRef.current(found.error);
  }, [found.error]);

  const edit = async (action: CatalogApproxEdit) => {
    if (safe === null) return;
    setPending(key);
    try {
      await editSharedApprox(action, safe);
      sharedPersonalApproxMirror.invalidate(key);
    } catch (error) {
      onError(error);
    } finally {
      setPending((value) => (value === key ? null : value));
    }
  };
  const busy = pending === key;
  return (
    <section aria-label={t("label")} aria-busy={busy}>
      {view === null ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          {view.entries.length === 0 ? (
            <p className="k-description is-spaced">{t("empty")}</p>
          ) : (
            <table className="settings-approx" aria-label={t("table")}>
              <tbody>
                {view.entries.map((entry) => (
                  <tr key={`${entry.a.id}/${entry.b.id}`}>
                    <td>
                      {tagName(entry.a)}
                      <TagMarks tag={entry.a} />
                      {t("pairSeparator")}
                      {tagName(entry.b)}
                      <TagMarks tag={entry.b} />
                    </td>
                    <td>{relationName(entry.relation)}</td>
                    <td>
                      <button
                        type="button"
                        className="k-btn is-sm is-quiet"
                        disabled={busy}
                        onClick={() => void edit({ kind: "remove", a: entry.a.id, b: entry.b.id })}
                      >
                        <span className="k-label">{t("remove")}</span>
                      </button>
                    </td>
                    {!!entry.sources.length && (
                      <td>
                        {t("from")}
                        {entry.sources.map((source) => (
                          <Tip key={source.libraryId} label={source.libraryRoot}>
                            <span>
                              {t("source", {
                                name: source.libraryName,
                                path: libraryPathHint(
                                  source.libraryRoot,
                                  entry.sources.map((item) => item.libraryRoot),
                                ),
                              })}
                            </span>
                          </Tip>
                        ))}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view.conflicts.map((conflict) => (
            <div
              role="group"
              aria-label={t("conflict")}
              className="k-approx-conflict"
              key={`${conflict.a.id}/${conflict.b.id}`}
            >
              <h3>{t("pair", { a: tagName(conflict.a), b: tagName(conflict.b) })}</h3>
              <p className="k-description is-spaced">
                {conflict.current === null
                  ? t("undecided")
                  : t("current", { relation: relationName(conflict.current) })}
              </p>
              <ul>
                {conflict.sources.map((source, index) => (
                  <Tip key={`${source.libraryId}/${index}`} label={source.libraryRoot}>
                    <li>
                      {t("sourceRelation", {
                        name: source.libraryName,
                        path: libraryPathHint(
                          source.libraryRoot,
                          conflict.sources.map((item) => item.libraryRoot),
                        ),
                        relation: relationName(source.relation),
                      })}
                    </li>
                  </Tip>
                ))}
              </ul>
              <div className="k-set-inline">
                {(
                  [
                    { relation: "similar", name: t("similar") },
                    { relation: "notSimilar", name: t("notSimilar") },
                    { relation: null, name: t("keep") },
                  ] as const
                ).map((choice) => (
                  <button
                    key={choice.name}
                    type="button"
                    className="k-btn is-sm"
                    disabled={busy}
                    onClick={() =>
                      void edit({
                        kind: "resolveConflict",
                        a: conflict.a.id,
                        b: conflict.b.id,
                        revision: view.revision,
                        relation: choice.relation,
                      })
                    }
                  >
                    <span className="k-label">{choice.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
