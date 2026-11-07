import type zh from "../zh-CN/legacyNames";
import type { Translation } from "../../translation";

const legacyNames: Translation<typeof zh> = {
  close: "Close",
  title: "Confirm older names",
  busy: "Loading or saving older names…",
  libraryOffline: "{{library}}: {{reason}}. Reconnect it, then confirm its older names.",
  saved: "Older names confirmed.",
  none: "No older names left to confirm.",
  reviewStep: "Review",
  step: "{{current, number}} / {{total, number}}",
  chosen: "{{chosen, number}} / {{total, number}} chosen",
  usedIn_one: "Used in {{count, number}} library: {{libraries}}",
  usedIn_other: "Used in {{count, number}} libraries: {{libraries}}",
  librarySeparator: ", ",
  differsFromPreference: "This differs from “{{name}}”, which you set before. Check the result before confirming.",
  choiceLabel: "Name to use",
  option: {
    followDefaultNamed: "Follow the default “{{name}}”",
    followDefault: "Follow the default",
    withdrawsPreference: "Withdraws your name “{{name}}”",
    followsUpdates: "Follows the default name when it's updated",
    noDefault: "No default name in this language yet; shown in another language",
    keepAsPreference: "Keep “{{name}}” as a shared preference",
    savedFrom: "Saved as the display name, from {{library}}",
    keepPrevious: "Keep the name you set before",
  },
  unnamed: "Unnamed tag",
  checking: "Checking the final display…",
  preview: {
    label: "Display after migration",
    tag: "Tag",
    display: "Final display",
    preference: "Changed display name",
    tagInLanguage: "{{tag}} ({{language}})",
    noPreference: "None, follows the default",
    previousPage: "Previous page",
    nextPage: "Next page",
  },
  bulk: "Use the default for the rest ({{count, number}})",
  done: "Done",
  cancel: "Cancel",
  previous: "Previous",
  confirm: "Confirm names",
  next: "Next",
  notice: {
    title_one: "{{count, number}} older name to confirm",
    title_other: "{{count, number}} older names to confirm",
    open: "Confirm one by one",
  },
  entry: {
    title: "Older names",
    hint: "From older libraries",
  },
};

export default legacyNames;
