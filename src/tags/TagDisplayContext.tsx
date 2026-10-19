import { createContext, useContext } from "react";
import type { TagDisplay } from "../bindings/TagDisplay";
import { DEFAULT_TAG_DISPLAY } from "./tagConfidence";

/** 当前的标签外观（#160）：主窗口按应用壳设置提供，设置一改就跟着变；没有提供时用默认值。 */
export const TagDisplayContext = createContext<TagDisplay>(DEFAULT_TAG_DISPLAY);

export const useTagDisplay = () => useContext(TagDisplayContext);
