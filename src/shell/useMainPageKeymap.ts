import type { Dispatch, SetStateAction } from "react";
import { usePageKeymap } from "../keymap/usePageKeymap";
import type { Section } from "./Rail";

const MAIN_PAGE_KEYS = [
  "main.togglePane",
  "main.sectionBrowse",
  "main.sectionGroups",
  "main.sectionCaptures",
  "main.sectionSubscriptions",
] as const;

/** 主窗口分页与侧栏的固定按键：Ctrl+B 开合侧栏，Ctrl+1…4 换分区。 */
export function useMainPageKeymap({
  setSection,
  setPaneOpen,
  subscriptionsOn,
}: {
  setSection: Dispatch<SetStateAction<Section>>;
  setPaneOpen: Dispatch<SetStateAction<boolean>>;
  subscriptionsOn: () => boolean;
}) {
  usePageKeymap(MAIN_PAGE_KEYS, (action) => {
    if (action === "main.togglePane") {
      setPaneOpen((open) => !open);
      return;
    }
    const section: Section | null =
      action === "main.sectionBrowse"
        ? "browse"
        : action === "main.sectionGroups"
          ? "groups"
          : action === "main.sectionCaptures"
            ? "captures"
            : action === "main.sectionSubscriptions" && subscriptionsOn()
              ? "subscriptions"
              : null;
    if (!section) return;
    setSection(section);
    setPaneOpen(true);
  });
}
