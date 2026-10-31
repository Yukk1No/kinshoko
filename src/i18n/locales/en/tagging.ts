import type zh from "../zh-CN/tagging";
import type { Translation } from "../../translation";

const tagging: Translation<typeof zh> = {
  device: {
    directMl: "GPU",
    cpu: "CPU",
  },
  activity: {
    downloading: "Downloading the auto-tagging model {{percent}}%",
    starting: "Loading the auto-tagging model",
    preparing: "Verifying the auto-tagging model",
    running_one: "Auto-tagging, {{count}} image tagged ({{device}})",
    running_other: "Auto-tagging, {{count}} images tagged ({{device}})",
    paused: "Paused",
    yieldedToFullScreen: "Paused for a full-screen app",
  },
  label: "Auto-tagging: {{text}}",
  openSettings: "Auto-tagging: {{text}}, open auto-tagging settings",
  notice: {
    downloaded: "Auto-tagging model downloaded",
    failed: "Auto-tagging failed: {{reason}}",
    retrying: "Retries automatically in a while",
    tagged_one: "Auto-tagging: tagged {{count}} new image",
    tagged_other: "Auto-tagging: tagged {{count}} new images",
    unavailable: "Auto-tagging unavailable: {{reason}}",
    downloading: "Downloading the auto-tagging model",
    downloadFailed: "Couldn't download the auto-tagging model: {{error}}",
    needsDownload: "The auto-tagging model needs to be downloaded ({{size}} MB)",
    resume: "Resume download",
    download: "Download",
  },
};

export default tagging;
