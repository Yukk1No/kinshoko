import type zh from "../zh-CN/inspector";
import type { Translation } from "../../translation";

const inspector: Translation<typeof zh> = {
  selection: {
    label: "Selected reference images",
    actions: "Actions for selected reference images",
    count_one: "{{count, number}} selected",
    count_other: "{{count, number}} selected",
    countShort_one: "{{count, number}} image",
    countShort_other: "{{count, number}} images",
    moveToFolder: "Move to folder",
    noFolders: "No folders yet",
    removeFromFolder: "Remove from this folder",
    restore: "Restore",
    purge: "Delete permanently…",
    trash: "Move to Trash",
    clear: "Clear selection",
    trashed: "Moved to Trash",
    trashedCount_one: "{{count, number}} image",
    trashedCount_other: "{{count, number}} images",
    undo: "Undo",
  },
  tagging: {
    unfinished: "Auto-tagging unfinished",
    retry: "Retry",
    unreadable: "This image can't be read",
    crashed: "An error occurred while processing this image",
  },
  rating: {
    label: "Content rating",
    title: "Rating",
    revert: "Back to automatic",
    autoOption: "{{rating}}, automatic",
    revertOption: "{{rating}}, back to automatic",
  },
  file: {
    collectedAt: "Collected {{at}}",
    newVersion: "Newer version: this image changed in Eagle; the older version is still kept in the library",
    oldVersion: "Older version: this image later changed in Eagle; the newer version is kept as a separate image",
  },
  folders: {
    label: "Folders",
    title: "Folders",
  },
  note: {
    title: "Note",
    fromSource: "Note (from the source)",
    placeholder: "Write something, e.g. what to look at",
    saveLabel: "Save note",
    save: "Save",
    revertLabel: "Restore the source's note",
    revertTitle: "Go back to the note from the source",
    revertEmptyTitle: "The source has no note; going back leaves the note empty",
    revert: "Restore source note",
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
  },
};

export default inspector;
