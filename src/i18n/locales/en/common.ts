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
};

export default common;
