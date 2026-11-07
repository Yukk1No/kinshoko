import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isLensChanged, onSafeModeSetting, onWorkspaceChanged, safeMode, workspaceStatus } from "../ipc";
import { TagGroupsPane } from "./TagGroupsPane";

/** The same application configuration editor is available without a current library. */
export function SharedTagGroupsSettings({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useTranslation("tagGroups");
  const [safe, setSafe] = useState<boolean | null>(null);
  const [generation, setGeneration] = useState(0);
  const modeRevision = useRef(0);
  const workspaceRevision = useRef<string | null>(null);
  const workspaceEvent = useRef(0);
  useEffect(() => {
    let alive = true; const revision = modeRevision.current;
    const baseline = async (on: boolean, mode: number) => {
      const event = workspaceEvent.current;
      try {
        const status = await workspaceStatus(on);
        if (alive && modeRevision.current === mode && workspaceEvent.current === event) workspaceRevision.current = status?.revision ?? null;
      } catch (error) {
        if (alive && modeRevision.current === mode && !isLensChanged(error)) onError(error);
      }
    };
    void safeMode().then(async (value) => {
      if (!alive || modeRevision.current !== revision || typeof value !== "boolean") return;
      // Establish the monitor revision before exposing editable drafts, and the actual saved safety mode.
      await baseline(value, revision);
      if (alive && modeRevision.current === revision) setSafe(value);
    }).catch((error) => { if (alive && modeRevision.current === revision) onError(error); });
    const mode = onSafeModeSetting((on) => {
      if (!alive) return;
      modeRevision.current++; setSafe(on); setGeneration((n) => n + 1);
      void baseline(on, modeRevision.current);
    });
    const workspace = onWorkspaceChanged((status) => {
      if (!alive) return;
      workspaceEvent.current++;
      if (workspaceRevision.current === status.revision) return;
      workspaceRevision.current = status.revision; setGeneration((n) => n + 1);
    });
    return () => { alive = false; for (const stop of [mode, workspace]) void stop.then((unlisten) => unlisten()).catch(() => {}); };
  }, [onError]);
  return <>
    <p className="k-set-note">{t("settingsNote")}</p>
    {safe === null ? <p role="status">{t("settingsLoading")}</p> : <TagGroupsPane label={t("settingsLabel")} safe={safe} generation={generation} onError={onError} />}
  </>;
}
