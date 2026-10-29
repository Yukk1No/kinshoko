// 样式测试读原始 CSS：把拆开的 main-window.css 按加载次序拼回一份。
import frame from "./main-window.css?raw";
import panels from "./main-window-panels.css?raw";

export default [frame, panels].join("\n");
