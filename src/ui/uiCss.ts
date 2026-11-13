// 样式测试读原始 CSS：把拆开的 ui.css 按加载次序拼回一份。
import base from "./ui.css?raw";
import dock from "./ui-dock.css?raw";

export default [base, dock].join("\n");
