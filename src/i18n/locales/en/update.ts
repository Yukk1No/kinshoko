import type zh from "../zh-CN/update";
import type { Translation } from "../../translation";

const update: Translation<typeof zh> = {
  group: "Updates",
  currentVersion: "Current version",
  upToDate: "Up to date",
  available: "Update available",
  checkFailed: "Check failed",
  manual: {
    title: "Manual update",
    hint: "Quit from the tray, then run the new installer",
    steps: "Quit Kinshoko from the tray, then run the new installer from the developer and install it to the same location. Open Kinshoko again to keep using your libraries, settings, reference groups and pins.",
    showSteps: "Show steps",
    hideSteps: "Hide steps",
  },
  automatic: {
    title: "Automatic updates",
    disabled: "Not enabled in this build",
  },
  channel: {
    title: "Update channel",
    stable: "Stable",
    beta: "Beta",
    stableHint: "Stable releases only",
    betaHint: "Beta, release candidate and stable releases",
  },
  install: {
    title: "Update to {{version}}",
    hint: "Restarts when installed",
    action: "Install and restart",
  },
  check: {
    title: "Check for updates",
    hint: "Look for a new release",
    action: "Check for updates",
  },
  progress: {
    starting: "Downloading update…",
    downloaded: "Downloading {{downloaded}} MB",
    downloadedOfTotal: "Downloading {{downloaded}} / {{total}} MB",
  },
  notice: {
    available: "Kinshoko {{version}} is available",
    installing: "Updating to {{version}}",
    failed: "Update failed",
    retry: "Retry",

  },
};

export default update;
