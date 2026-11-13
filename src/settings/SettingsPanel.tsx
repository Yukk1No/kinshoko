import { useState, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useTranslation } from "react-i18next";
import { Pin, Power, Scaling, Tags } from "lucide-react";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import { errorText } from "../ipc";
import { useShellSettings, type ShellSettings, type ShellSettingsIntent } from "../shell/useShellSettings";
import { SharedPersonalApproxSettings } from "../search/SharedPersonalApproxSettings";
import { LegacyNameEntry } from "../library/LegacyNameMigrationPanel";
import { SharedTagGroupsSettings } from "../library/SharedTagGroupsSettings";
import { TagNamePanel } from "../library/TagNamePanel";
import { TagIdentityPanel } from "../library/TagIdentityPanel";
import { ApplicationSettingsBackup } from "./ApplicationSettingsBackup";
import { TagDisplaySettings } from "./TagDisplaySettings";
import { BackupSettings } from "./Backup";
import { AutoTaggingSettings } from "./AutoTaggingSettings";
import { UpdateSection } from "../Update";
import { useDiagnosticsReport } from "../RuntimeSupport";
import { Segmented } from "../ui/Segmented";
import { DialogHeight, DialogSwap } from "../ui/DialogHeight";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";
import { UI_SCALE_LEVELS } from "../shell/uiScale";
import { Select } from "../ui/Select";
import { tabName, tabsWith, type SettingsTab } from "./settingsTabs";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { KeysPage } from "./SettingsKeysPage";
import { SafetyPage } from "./SettingsSafetyPage";
import { DiagPage } from "./SettingsDiagPage";
import { SubscriptionSettings } from "../subscriptions/SubscriptionSettings";

export type { SettingsTab };

type TagView = "names" | "groups" | "approx" | "mapping" | "appearance";
const TAG_VIEWS: TagView[] = ["names", "groups", "approx", "mapping", "appearance"];

type Props = {
  onRestored?: () => void;
  /** 打开的资料库；自动标签分页从它开始跟随后端的可写资料库。个人规则不依赖它。 */
  /** 本设备登记了资料库（设置 › 打标的状态行）。 */
  hasLibrary?: boolean;
  /** 主窗口持有的设置提交模型（#321）：关掉再打开设置也共用一个队列。没有时设置页自己建一个。 */
  settings?: ShellSettings;
  /** 应用壳设置保存后的结果（只在没有传入 `settings` 时用），主窗口据此更新（例如相近标签来源标记）。 */
  onChange?: (view: ShellSettingsView) => void;
  /** 打开时所在的分页。 */
  initialTab?: SettingsTab;
  /** 打开时在 标签 › 显示名 里定位并展开的统一标签（#182）。 */
  initialTagFocus?: string;
  /** 导航底部的版本，例如“Kinshoko 0.1.2”。 */
  version?: string | null;
  /** 安全模式（主窗口持有）；没有时安全分页只说明行为。 */
  safe?: boolean;
  onSafeMode?: () => void;
  /** 打开“确认旧名称”向导（标签分页的提示条）。 */
  onOpenNameWizard?: () => void;
  /** 界面缩放档位（主窗口持有，#173）；没有时通用分页不显示这一项。 */
  uiScale?: number;
  onUiScale?: (percent: number) => void;
  /** 订阅状态（主窗口持有）；没有时不显示订阅分页。 */
  subscriptions?: { status: SubscriptionStatus; onStatus: (status: SubscriptionStatus) => void } | null;
  /** 自动标签里“查看”没有完成的图（#475）：关掉设置，回到图片墙筛出这些图。 */
  onShowUnfinishedTagging?: () => void;
};

/**
 * 程序设置（#98）：竖排八个分页——通用、快捷键、标签、自动标签（#143）、备份、安全、更新、诊断。
 * 每项一行：图标 · 名称 · 一句描述 · 右侧控件。行为与原来的各节相同，只是重新归位。
 */
export function SettingsPanel({
  settings: shared,
  onChange,
  onRestored,
  hasLibrary = false,
  initialTab = "general",
  initialTagFocus,
  version,
  safe,
  onSafeMode,
  onOpenNameWizard,
  uiScale,
  onUiScale,
  subscriptions,
  onShowUnfinishedTagging,
}: Props) {
  const { t } = useTranslation("settings");
  const settings = useShellSettings(shared, onChange);
  const { view, loadError, error, generation: settingsGeneration } = settings;
  const setError = settings.showError;
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [tagView, setTagView] = useState<TagView>("names");
  const diagnostics = useDiagnosticsReport((e) => setError(errorText(e)));

  /** 提交一项改动；返回是否成功，失败时说明原因，界面留在已接受的设置上。 */
  const apply = (intent: ShellSettingsIntent) => settings.submit(intent);

  if (view === null) {
    return (
      <section className="k-settings is-loading" aria-label={t("label")}>
        {loadError === null ? (
          <p className="k-set-note" role="status">
            {t("loading")}
          </p>
        ) : (
          <div className="k-set-load-error">
            <p className="k-set-error" role="alert">
              {t("loadFailed", { error: loadError })}
            </p>
            <button type="button" className="k-btn" onClick={settings.retryLoad}>
              <span className="k-label">{t("retry")}</span>
            </button>
          </div>
        )}
      </section>
    );
  }
  const restore = async (path: string, fingerprint: string) => {
    const restored = await settings.restore(path, fingerprint);
    onRestored?.();
    return restored;
  };
  // 只渲染当前页，退场由 DialogSwap 保留旧元素。keepMounted 不能省：否则旧页一转为未选中，Tabs.Panel 就自己卸载，淡出看不到。
  const panel = (value: SettingsTab, children: ReactNode, full = false) =>
    value !== tab ? null : (
      <Tabs.Panel keepMounted value={value} className={full ? "k-set-page is-full" : "k-set-page"}>
        {children}
      </Tabs.Panel>
    );
  const page = (value: SettingsTab, children: ReactNode, full = false) =>
    panel(
      value,
      <>
        <h3 className="k-set-title">{tabName(value)}</h3>
        {error !== null && (
          <p className="k-set-error" role="alert">
            {error}
          </p>
        )}
        {children}
      </>,
      full,
    );

  return (
    <section className="k-settings" aria-label={t("label")}>
      <Tabs.Root
        value={tab}
        onValueChange={(next) => {
          setTab(next as SettingsTab);
          setRecording(null);
          setError(null);
        }}
        orientation="vertical"
        className="k-set-body"
      >
        <nav className="k-set-nav">
          <h2 className="k-set-heading">{t("heading")}</h2>
          <Tabs.List className="k-set-tabs" aria-label={t("tabsLabel")} activateOnFocus>
            <Tabs.Indicator className="k-set-tab-indicator" />
            {tabsWith(!!subscriptions).map((entry) => (
              <Tabs.Tab key={entry.value} value={entry.value} className="k-set-tab">
                {entry.icon}
                <span className="k-label">{tabName(entry.value)}</span>
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <span className="k-grow" />
          {version && <p className="k-set-version">{version}</p>}
        </nav>
        <DialogHeight className="k-set-main">
          {/* 序号按含订阅的完整顺序算：订阅状态晚到时，当前页的序号不变，不会多播一次交替。 */}
          <DialogSwap step={tabsWith(true).findIndex((entry) => entry.value === tab)} axis="y">
            {page(
              "general",
              <>
                <SettingsGroup label={t("general.group")}>
                  <SettingsRow
                    icon={<Power size={16} />}
                    title={t("general.autostart")}
                    hint={t("general.autostartHint")}
                  >
                    <Switch
                      label={t("general.autostart")}
                      checked={view.autostart}
                      onCheckedChange={(on) => void apply({ kind: "autostart", on })}
                    />
                  </SettingsRow>
                  {uiScale !== undefined && onUiScale && (
                    <SettingsRow
                      icon={<Scaling size={16} />}
                      title={t("general.uiScale")}
                      hint={t("general.uiScaleHint")}
                    >
                      <Select
                        label={t("general.uiScale")}
                        value={String(uiScale)}
                        onChange={(value) => onUiScale(Number(value))}
                        options={UI_SCALE_LEVELS.map((percent) => ({ value: String(percent), label: `${percent}%` }))}
                      />
                    </SettingsRow>
                  )}
                </SettingsGroup>
                <SettingsGroup label={t("general.pinsGroup")}>
                  <SettingsRow icon={<Pin size={16} />} title={t("general.pinEdge")} hint={t("general.pinEdgeHint")}>
                    <Switch
                      label={t("general.pinEdge")}
                      checked={view.pinEdgeContrast}
                      onCheckedChange={(on) => void apply({ kind: "pinEdgeContrast", on })}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </>,
            )}
            {page("keys", <KeysPage view={view} recording={recording} setRecording={setRecording} apply={apply} />)}
            {page(
              "tags",
              <>
                <Segmented<TagView>
                  className="k-set-seg"
                  label={t("tags.viewLabel")}
                  value={tagView}
                  onChange={setTagView}
                  options={TAG_VIEWS.map((value) => ({ value, label: t(`tags.view.${value}`) }))}
                />
                {tagView === "appearance" && (
                  <TagDisplaySettings
                    key={`appearance/${settingsGeneration}`}
                    display={settings.tagDisplay}
                    onChange={settings.changeTagDisplay}
                  />
                )}
                {tagView === "names" && (
                  <>
                    <TagNamePanel key={`names/${settingsGeneration}`} focus={initialTagFocus} />
                    <LegacyNameEntry onOpen={onOpenNameWizard} />
                  </>
                )}
                {tagView === "groups" && (
                  <SharedTagGroupsSettings
                    key={`groups/${settingsGeneration}`}
                    onError={(e) => setError(errorText(e))}
                  />
                )}
                {tagView === "approx" && (
                  <>
                    <SettingsGroup label={t("tags.approxGroup")}>
                      <SettingsRow
                        icon={<Tags size={16} />}
                        title={t("tags.showSource")}
                        hint={t("tags.showSourceHint")}
                      >
                        <Switch
                          label={t("tags.showSource")}
                          checked={view.showApproxSource}
                          onCheckedChange={(on) => void apply({ kind: "showApproxSource", on })}
                        />
                      </SettingsRow>
                    </SettingsGroup>
                    <SharedPersonalApproxSettings
                      key={`approx/${settingsGeneration}`}
                      onError={(e) => setError(errorText(e))}
                    />
                  </>
                )}
                {tagView === "mapping" && <TagIdentityPanel key={`identity/${settingsGeneration}`} />}
              </>,
              true,
            )}
            {page(
              "tagging",
              <AutoTaggingSettings
                key={`tagging/${settingsGeneration}`}
                hasLibrary={hasLibrary}
                onShowUnfinished={onShowUnfinishedTagging}
              />,
            )}
            {page(
              "backup",
              <>
                <BackupSettings />
                <ApplicationSettingsBackup restore={restore} />
              </>,
            )}
            {page("safety", <SafetyPage view={view} safe={safe} onSafeMode={onSafeMode} apply={apply} />)}
            {subscriptions &&
              panel(
                "subscriptions",
                <SubscriptionSettings
                  status={subscriptions.status}
                  onStatus={subscriptions.onStatus}
                  error={error}
                  onError={setError}
                />,
              )}
            {page(
              "update",
              <UpdateSection
                version={version ?? null}
                channel={view.updateChannel}
                onChannel={(channel) => apply({ kind: "updateChannel", channel })}
              />,
            )}
            {page("diag", <DiagPage view={view} diagnostics={diagnostics} setError={setError} apply={apply} />)}
          </DialogSwap>
        </DialogHeight>
      </Tabs.Root>
    </section>
  );
}
