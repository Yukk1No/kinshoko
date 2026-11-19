import type zh from "../zh-CN/pins";
import type { Translation } from "../../translation";

const pins: Translation<typeof zh> = {
  notice: {
    locked: "Locked",
    unlocked: "Unlocked",
    copied: "Copied",
    chooseSaveLocation: "Choose where to save it in the main window",
  },
};

export default pins;
