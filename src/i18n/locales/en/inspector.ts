import type zh from "../zh-CN/inspector";
import type { Translation } from "../../translation";

const inspector: Translation<typeof zh> = {
  selection: {
    label: "Selected reference images",
    actions: "Actions for selected reference images",
    count_one: "{{count}} selected",
    count_other: "{{count}} selected",
    countShort_one: "{{count}} image",
    countShort_other: "{{count}} images",
    moveToFolder: "Move to folder",
    moveTo: "Move to",
    noFolders: "No folders yet",
    removeFromFolder: "Remove from this folder",
    restore: "Restore",
    purge: "Delete permanently…",
    trash: "Move to Trash",
    delete: "Delete",
    clear: "Clear selection",
    trashed: "Moved to Trash",
    trashedCount_one: "{{count}} image",
    trashedCount_other: "{{count}} images",
    undo: "Undo",
  },
  rating: {
    label: "Content rating",
    title: "Rating",
    unrated: "Not rated yet",
    manual: "Set by hand",
    revert: "Back to automatic ({{auto}})",
    auto: "Automatic rating: {{auto}}",
  },
  file: {
    collectedAt: "Collected {{at}}",
    newVersion: "Newer version: this image changed in Eagle; the older version is still kept in the library",
    oldVersion: "Older version: this image later changed in Eagle; the newer version is kept as a separate image",
  },
  folders: {
    label: "Folders",
    title: "Folders",
    remove: "Remove from “{{name}}”",
    none: "Not in any folder",
  },
  note: {
    title: "Note",
    fromSource: "Note (from the source)",
    placeholder: "Write something, e.g. what to look at",
    saveLabel: "Save note",
    save: "Save",
    revertLabel: "Use the source's note",
    revertTitle: "Go back to the note from the source",
    revertEmptyTitle: "The source has no note; going back leaves the note empty",
    revert: "Use source's",
  },
  links: "Source links",
  sources: {
    label: "Library sources",
    picker: "Library",
    trash: "Trash",
    offline: "Not connected",
    titleSeparator: ", ",
  },
  source: {
    label: "Organize source",
    loading: "Loading this source…",
    copyTo: "Copy to…",
    copyTitle: "Copy this source",
    copyConfirm: "Copy",
    copied: "Copied this source. Anything organized by hand at the destination stays as it was",
  },
};

export default inspector;
