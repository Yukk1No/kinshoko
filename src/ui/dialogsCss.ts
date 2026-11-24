// 样式测试读原始 CSS：把拆开的 dialogs.css 按加载次序拼回一份。
import base from "./dialogs.css?raw";
import tasks from "./dialogs-tasks.css?raw";

export default [base, tasks].join("\n");
