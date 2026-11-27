import { useEffect, useRef, useState } from "react";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import type { TagNamespace } from "../bindings/TagNamespace";
import { describeCommandError, errorText } from "../ipc/commandError";
import { correctTagMapping, onSafeModeSetting, publishTagDefinitions } from "../ipc";

import { libraryPathHint } from "./library-path";
import { acceptTagCatalog, invalidateTagCatalog, useTagCatalog } from "./tagCatalogMirrors";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { useUiLang } from "../i18n";
import { i18n } from "../i18n/instance";
import { useTranslation } from "react-i18next";
import { Tip } from "../ui/Tip";

const namespaceName = (namespace: TagNamespace) => i18n.t(`tags:namespaceOption.${namespace}`);
const nameOf = (tag: CatalogTag, lang: string) =>
  tag.names.find((n) => n.lang === lang)?.name ??
  tag.names[0]?.name ??
  tag.external[0]?.name.replaceAll("_", " ") ??
  i18n.t("tags:unnamed");
const localName = (mapping: LibraryTagMapping, lang: string) =>
  mapping.legacy.names.find((n) => n.lang === lang)?.name ??
  mapping.legacy.names[0]?.name ??
  mapping.legacy.external[0]?.replaceAll("_", " ") ??
  i18n.t("tags:unnamed");

/** Settings fieldset and explicit row actions follow the approved reference-browser SettingsDialog. */
export function TagIdentityPanel() {
  const { t } = useTranslation("tagSettings");
  const [inspected, setInspected] = useState(false);
  const catalog = useTagCatalog(inspected);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [actionBusy, setActionBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const unlisten = onSafeModeSetting(() => {
      generation.current++;
      setInspected(false);
      setError(null);
      setActionBusy(false);
    });
    return () => {
      generation.current++;
      // 忽略失败：收尾时取消监听；之后的事件不再处理。
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const run = async (action: () => Promise<TagCatalogWorkspace>, success?: string) => {
    const request = ++generation.current;
    setActionBusy(true);
    setError(null);
    try {
      const next = await action();
      if (request === generation.current) {
        acceptTagCatalog(next);
        if (success) toast.show({ title: success, tone: "success" });
      }
    } catch (reason) {
      if (request === generation.current) setError(errorText(reason));
    } finally {
      if (request === generation.current) setActionBusy(false);
    }
  };
  const inspect = () => {
    setError(null);
    setInspected(true);
    // 已经订阅过时手动让镜像重读；第一次点击时订阅本身会开始读，没在订阅时这句自然落空。
    invalidateTagCatalog();
  };
  const workspace = inspected ? catalog.value : null;
  const busy = actionBusy || (inspected && catalog.refreshing);
  const mirrorError = inspected && !catalog.refreshing && catalog.error !== null ? errorText(catalog.error) : null;
  // 自动重读不改写本地操作错误：未解决的发布失败要留到画师显式重试。
  const shownError = error ?? mirrorError;
  return (
    <section className="tag-identity" aria-label={t("identity.label")}>
      <button type="button" className="k-btn is-sm" disabled={busy} onClick={inspect}>
        <span className="k-label">{t("identity.inspect")}</span>
      </button>
      {busy && <p role="status">{t("identity.loading")}</p>}
      {shownError && <p role="alert">{shownError}</p>}
      {workspace && (
        <>
          {workspace.libraries.map(({ library, unavailable }) => (
            <div key={"definitions-" + library.id} className="settings-actions">
              <Tip label={library.root} align="start">
                <span className="k-parts">
                  <span>{library.name}</span>
                  <span className="k-description is-spaced">
                    {libraryPathHint(
                      library.root,
                      workspace.libraries.map((entry) => entry.library.root),
                    )}
                  </span>
                </span>
              </Tip>
              <button
                type="button"
                className="k-btn is-sm"
                aria-label={t("identity.publishLabel", { name: library.name })}
                disabled={busy || Boolean(unavailable)}
                onClick={() => void run(() => publishTagDefinitions(library.id), t("identity.published"))}
              >
                <span className="k-label">{t("identity.publish")}</span>
              </button>
            </div>
          ))}
          {workspace.libraries
            .filter((entry) => entry.unavailable)
            .map(({ library, unavailable }) => (
              <p key={library.id} role="status">
                {t("libraryUnavailable", { name: library.name, reason: describeCommandError(unavailable!) })}
              </p>
            ))}
          {workspace.catalog.mappings.length === 0 ? (
            <p className="k-description is-spaced">{t("noTags")}</p>
          ) : (
            <table className="settings-shortcuts">
              <thead>
                <tr>
                  <th>{t("identity.columnLibrary")}</th>
                  <th>{t("identity.columnTarget")}</th>
                  <th>{t("identity.columnCorrect")}</th>
                </tr>
              </thead>
              <tbody>
                {workspace.catalog.mappings.map((mapping) => (
                  <MappingRow
                    key={`${mapping.libraryId}/${mapping.localTagId}`}
                    mapping={mapping}
                    workspace={workspace}
                    busy={busy}
                    onSave={(catalogId) =>
                      void run(() =>
                        correctTagMapping(
                          mapping.libraryId,
                          mapping.localTagId,
                          catalogId === "separate" ? { kind: "separate" } : { kind: "use", catalogId },
                        ),
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function MappingRow({
  mapping,
  workspace,
  busy,
  onSave,
}: {
  mapping: LibraryTagMapping;
  workspace: TagCatalogWorkspace;
  busy: boolean;
  onSave: (id: string) => void;
}) {
  const lang = useUiLang();
  const { t } = useTranslation("tagSettings");
  const [target, setTarget] = useState(mapping.catalogId);
  // 对应变了才跟着重置选择。不用 effect：挂载时的 effect 晚于首次渲染执行，会盖掉在那之前做的选择。
  const [shown, setShown] = useState(mapping.catalogId);
  if (shown !== mapping.catalogId) {
    setShown(mapping.catalogId);
    setTarget(mapping.catalogId);
  }
  const library = workspace.libraries.find((entry) => entry.library.id === mapping.libraryId)?.library;
  const shared = workspace.catalog.tags.find((tag) => tag.id === mapping.catalogId);
  const candidates = workspace.catalog.tags.filter((tag) => tag.namespace === mapping.legacy.namespace);
  // 同名候选按出现顺序编号区分，不显示内部编号。
  const seen = new Map<string, number>();
  const choices = candidates.map((tag) => {
    const name = nameOf(tag, lang),
      n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const same = candidates.filter((other) => nameOf(other, lang) === name).length > 1;
    return {
      tag,
      label: t(same ? "identity.choiceNumbered" : "identity.choice", {
        name,
        namespace: namespaceName(tag.namespace),
        n,
      }),
    };
  });
  return (
    <tr data-library-id={mapping.libraryId} data-local-tag-id={mapping.localTagId}>
      <th scope="row">
        <span className="k-parts">
          <span>{library?.name ?? t("libraryClosed")}</span>
          <span>{localName(mapping, lang)}</span>
          <small>{namespaceName(mapping.legacy.namespace)}</small>
        </span>
        <p className="k-description is-spaced">
          {mapping.nameProvenance === "pending"
            ? t("identity.pendingName")
            : t("identity.aliases", {
                aliases: mapping.legacy.aliases.map((a) => a.name).join(t("separator")) || t("none"),
              })}
        </p>
        <details>
          <summary>{t("details")}</summary>
          <p>{t("identity.localId", { id: mapping.localTagId })}</p>
          <p>
            {t("names.external", {
              names: mapping.legacy.external.map((name) => `danbooru:${name}`).join(t("separator")) || t("none"),
            })}
          </p>
        </details>
      </th>
      <td>
        <span className="k-parts">
          <span>{shared ? nameOf(shared, lang) : i18n.t("tags:unnamed")}</span>
          <small>{t(`identity.basis.${mapping.basis}`)}</small>
        </span>
        <details>
          <summary>{t("details")}</summary>
          <p>{t("identity.catalogId", { id: mapping.catalogId })}</p>
          <p>
            {t("names.external", {
              names: shared?.external.map((e) => `${e.vocabulary}:${e.name}`).join(t("separator")) || t("none"),
            })}
          </p>
        </details>
      </td>
      <td>
        <Select
          label={t("identity.correctLabel", {
            library: library?.name ?? t("libraryClosed"),
            name: localName(mapping, lang),
          })}
          value={target}
          disabled={busy}
          onChange={setTarget}
          options={[
            ...choices.map(({ tag, label }) => ({ value: tag.id, label })),
            { value: "separate", label: t("identity.separate") },
          ]}
        />
        <button
          type="button"
          className="k-btn is-sm"
          disabled={busy || target === mapping.catalogId}
          onClick={() => onSave(target)}
        >
          <span className="k-label">{t("identity.save")}</span>
        </button>
      </td>
    </tr>
  );
}
