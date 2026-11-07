import type zh from "../zh-CN/pins";
import type { Translation } from "../../translation";

const pins: Translation<typeof zh> = {
  notice: {
    locked: "Locked",
    unlocked: "Unlocked",
    copied: "Copied",
    chooseSaveLocation: "Choose where to save it in the main window",
    collectFirst: "Collect the capture into a library before adding it to a reference group",
    savedToGroup: "Saved back to reference group “{{name}}”",
    addedToGroup: "Added to reference group “{{name}}”",
  },
};

export default pins;
