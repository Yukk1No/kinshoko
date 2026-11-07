import type zh from "../zh-CN/common";
import type { Translation } from "../../translation";

const common: Translation<typeof zh> = {
  image: {
    pinWhole: "Pin whole image",
    pinPart: "Pin a region",
    copy: "Copy image",
    reveal: "Show in File Explorer",
    trash: "Move to Trash",
    copied: "Image copied",
    pinFailed: "Couldn't pin: {{error}}",
    copyFailed: "Couldn't copy the image: {{error}}",
    revealFailed: "Couldn't show in File Explorer: {{error}}",
  },
  rating: {
    general: "General",
    sensitive: "Mild",
    questionable: "Sensitive",
    explicit: "Adult",
  },
  libraryFailure: "“{{name}}”: {{error}}",
  libraryFailureSeparator: "; ",
  saveDestination: {
    chooseBoth: "Choose a library and folder",
    unassigned: "Unsorted",
    folderGone: "This folder no longer exists",
    libraryClosed: "Library not open",
    label: "{{library}} / {{folder}}",
    legend: "Save location",
    library: "Library",
    putInLibrary: "Put in library",
    chooseLibrary: "Choose a library…",
    libraryOption: "{{name}} ({{path}})",
    libraryOptionOffline: "{{name}} ({{path}}) (not connected)",
    folder: "Folder",
    putIn: "Goes to: {{place}}",
    loading: "Loading libraries…",
    unavailable: "This location isn't available right now. Reconnect the original library, or choose another location.",
    description: "Choose a library and folder.",
    save: "Save",
    cancel: "Cancel",
    saving: "Saving…",
  },
};

export default common;
