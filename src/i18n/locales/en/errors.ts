import type zh from "../zh-CN/errors";
import type { Translation } from "../../translation";

import library from "./errors/library";
import domain from "./errors/domain";
import shell from "./errors/shell";
import reasons from "./errors/reasons";

const errors: Translation<typeof zh> = {
  ...library,
  ...domain,
  ...shell,
  ...reasons,
};

export default errors;
