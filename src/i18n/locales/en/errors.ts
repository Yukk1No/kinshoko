import type zh from "../zh-CN/errors";
import type { Translation } from "../../translation";

import library from "./errors/library";
import domain from "./errors/domain";
import shell from "./errors/shell";
import reasons from "./errors/reasons";
import tagging from "./errors/tagging";

const errors: Translation<typeof zh> = {
  ...library,
  ...domain,
  ...shell,
  ...reasons,
  ...tagging,
};

export default errors;
