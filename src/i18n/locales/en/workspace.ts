import type zh from "../zh-CN/workspace";
import type { Translation } from "../../translation";

const workspace: Translation<typeof zh> = {
  openFailed: "Couldn't open this reference image: {{error}}",
  expandPane: "Expand sidebar",
  expandPaneTitle: "Expand sidebar Ctrl B",
  collapsePane: "Collapse sidebar",
  collapsePaneTitle: "Collapse sidebar Ctrl B",
  results: "Search results",
  resultCount_one: "{{count}} image",
  resultCount_other: "{{count}} images",
  gotIt: "Got it",
  copyOneOnly: "Copies one image at a time",
  pane: {
    folders: "Folders",
    groups: "Reference groups",
    captures: "Captures",
    capturesLabel: "Capture history",
  },
  inspector: {
    label: "Details",
    collapse: "Collapse details",
    title: "Details",
  },
  organizeWaiting: {
    title: "Organizing after the import finishes",
    description: "Runs once the import into {{names}} finishes",
    name: "“{{name}}”",
    separator: ", ",
  },
};

export default workspace;
