import type zh from "../zh-CN/shell";
import type { Translation } from "../../translation";

const shell: Translation<typeof zh> = {
  nav: {
    label: "Main navigation",
    browse: "Images and folders",
    groups: "Reference groups",
    captures: "Capture history",
    settings: "Settings",
    settingsTip: "Settings",
  },
  safeMode: {
    on: "Safe mode: on",
    off: "Safe mode: off",
    tipOn: "Safe mode: on, adult images are sealed",
    tipOff: "Safe mode: off",
    toggleFailed: "Couldn't switch safe mode: {{error}}",
  },
  window: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
  },
  toast: {
    label: "Notifications",
    gotIt: "Got it",
    dismissLabel: "Dismiss notification",
    dismiss: "Dismiss",
  },
  import: {
    label: "Import",
    busyLabel: "Importing",
    files: "Images",
    folder: "Folder",
    eagle: "Import from Eagle",
    findingEagle: "Looking for Eagle libraries…",
    tasks: "Import tasks",
  },
  dock: "Tools",
  dockItem: "{{label}}, {{shortcut}}",
  resizeInspector: "Resize details",
  resizeInspectorTitle: "Resize",
  opening: "Opening the library…",
  openingLabel: "Opening the library",
  openFailed: "Couldn't open the last library: {{error}}",
  uiScaleFailed: "Couldn't change the interface scale: {{error}}",
  emptyPane: {
    groups: "Reference groups",
    captures: "Captures",
    capturesLabel: "Capture history",
    collapse: "Collapse sidebar",
  },
  backToLibrary: "Back to the library",
  back: "Back",
  settingsTitle: "Settings",
  closeSettings: "Close settings",
};

export default shell;
