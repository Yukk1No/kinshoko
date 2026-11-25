import type zh from "../zh-CN/workspace";
import type { Translation } from "../../translation";

const workspace: Translation<typeof zh> = {
  openFailed: "Couldn't open this reference image: {{error}}",
  expandPane: "Expand sidebar",
  collapsePane: "Collapse sidebar",
  results: "Search results",
  resultCount_one: "{{count, number}} image",
  resultCount_other: "{{count, number}} images",
  copyOneOnly: "Copies one image at a time",
  empty: {
    importFiles: "Import images",
    importFolder: "Import a folder",
    clearConditions: "Clear search",
  },
  pane: {
    folders: "Folders",
    groups: "Reference groups",
    captures: "Screenshots",
    capturesLabel: "Screenshot history",
  },
  inspector: {
    label: "Details",
    collapse: "Collapse details",
    title: "Details",
    empty: "Select an image to see its tags and sources here",
  },
  organizeWaiting: {
    title: "Organizing after the import finishes",
    description: "Runs once the import into {{names}} finishes",
    name: "“{{name}}”",
    separator: ", ",
  },
};

export default workspace;
