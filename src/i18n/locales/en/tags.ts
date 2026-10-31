import type zh from "../zh-CN/tags";
import type { Translation } from "../../translation";

const tags: Translation<typeof zh> = {
  namespace: {
    general: "",
    artist: "Artist: ",
    character: "Character: ",
    work: "Work: ",
  },
  untranslated: "No English name yet; showing the original name",
  noExternal: "No external mapping; not in the built-in approximate match table",
};

export default tags;
