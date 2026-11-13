import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, } from "lucide-react";
import type { LegacyNameGroup } from "../bindings/LegacyNameGroup";
import { onLibraryEvent, onSafeModeSetting, onWorkspaceChanged, planLegacyNames, } from "../ipc";
import { logFailure } from "../runLog";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { usePersistentToast } from "../ui/Toast";


// 旧名称待确认的提示条与设置入口，原样从 LegacyNameMigrationPanel.tsx 移出。

/** 向导确认后通知各处的“旧名称待确认”提示重新读取。 */
export const CHANGED = "kinshoko:legacy-names-changed";

/** 词表连续变化时，两次旧名称检查之间至少隔开这么久（#142）。 */
const REREAD_DELAY_MS = 200;

/**
 * 读取待确认的旧名称；词表变化、导入结束或向导确认后重读，安全模式切换时先清空。
 * 自动打标每写一张图都会发 vocabularyChanged，而 plan_legacy_names 很重（#142）：同一时刻最多一次在途，
 * 在途或等待期间来的变化只记下，返回后最多补读一次。
 */
function usePendingLegacyNames(match: (group: LegacyNameGroup) => boolean, deps: unknown[]) {
  const [count, setCount] = useState(0);
  const [settled, setSettled] = useState(false);
  const countMatching = useEffectEvent((groups: LegacyNameGroup[]) => groups.filter(match).length);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let running = false;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCount(0); setSettled(false);
    const start = () => {
      timer = undefined;
      if (!alive) return;
      stale = false;
      running = true;
      const request = ++generation;
      void planLegacyNames().then((view) => {
        if (alive && request === generation) setCount(view ? countMatching(view.plan.groups) : 0);
      // 读不出时数量按 0，不弹通知；向导里打开时会显示原因。记一条，排查时知道通知为什么没出现。
      }).catch((e) => logFailure("plan legacy names", e)).finally(() => {
        running = false;
        if (alive && request === generation) setSettled(true);
        if (alive && stale) schedule();
      });
    };
    const schedule = () => { if (!running && timer === undefined) timer = setTimeout(start, REREAD_DELAY_MS); };
    const read = () => { stale = true; schedule(); };
    start();
    const unlisten = onLibraryEvent((event) => { if (event.kind === "vocabularyChanged" || event.kind === "taskFinished") read(); });
    const safeStop = onSafeModeSetting(() => { generation++; setCount(0); setSettled(false); read(); });
    // 待确认的旧名称合计所有图库：登记或可用状态变了就重读；只是修订前进（每次写入都有）不读。
    let registrations: string | null = null;
    const workspaceStop = onWorkspaceChanged((status) => {
      const next = status.libraries.map((entry) => `${entry.library.id}:${entry.unavailable ? 0 : 1}`).sort().join("|");
      if (next === registrations) return;
      registrations = next;
      read();
    });
    window.addEventListener(CHANGED, read);
    return () => {
      alive = false; generation++;
      clearTimeout(timer);
      window.removeEventListener(CHANGED, read);
      // 忽略失败：收尾时取消监听；之后的事件不再处理。
      for (const stop of [unlisten, safeStop, workspaceStop]) void stop.then((off) => off()).catch(() => {});
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: 何时重读由调用方的 deps 决定，回调里只读局部变量与 countMatching
  }, deps);
  return { count, settled };
}

/**
 * 主窗口的旧名称通知（#433）：关掉后只有待确认数量超过关掉时的数量才再弹，所以切换安全模式不会打扰。
 * 重读期间沿用上次的数量，切换安全模式时通知不闪。
 */
export function LegacyNameMigrationNotice({ safe, enabled, hidden, onOpen }: { safe: boolean; enabled: boolean; hidden: boolean; onOpen: () => void }) {
  const { t } = useTranslation("legacyNames", { keyPrefix: "notice" });
  const { count, settled } = usePendingLegacyNames(() => true, [safe]);
  const pending = useRef(0);
  if (settled) pending.current = count;
  usePersistentToast(enabled && pending.current > 0
    ? { title: t("title", { count: pending.current }), action: { label: t("open"), onClick: onOpen } }
    : null, { hidden, level: pending.current });
  return null;
}

/** 设置 › 标签 › 显示名底部：通知关掉后从这里进向导。 */
export function LegacyNameEntry({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation("legacyNames");
  const { count: pending } = usePendingLegacyNames(() => true, []);
  if (pending === 0 || !onOpen) return null;
  return <SettingsGroup label={t("entry.title")}>
    <SettingsRow icon={<Sparkles size={16} />} title={t("entry.title")} hint={t("entry.hint")} warn={<span role="status">{t("notice.title", { count: pending })}</span>}>
      <button type="button" className="k-btn is-sm" onClick={onOpen}><span className="k-label">{t("notice.open")}</span></button>
    </SettingsRow>
  </SettingsGroup>;
}
