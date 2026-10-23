// XPath helpers shared by CombinationWorkflow and its phase modules.
export const literal = value => String(value).includes("'") ? "concat(" + String(value).split("'").map(part => "'"+part+"'").join(",\"'\",") + ")" : "'"+value+"'";
export const blank = { conditions: [] };
export const allScope = { kind: "all" };
// #98 redesign: controls are found by role and accessible name. Dock buttons are named "名称，快捷键".
export const named = value => `(@aria-label=${literal(value)} or starts-with(@aria-label,${literal(value+"，")}) or normalize-space()=${literal(value)})`;
// Base UI dialogs are named by their title (aria-labelledby); older dialogs by aria-label.
export const dialog = name => `//*[@role='dialog' and (@aria-label=${literal(name)} or @aria-labelledby=//*[normalize-space()=${literal(name)}]/@id)]`;
export const importDialog = dialog("导入图片"), eagleDialog = dialog("从 Eagle 导入");
// The save-destination selects are named by their visible labels (“放到图库” or “图库”, and “文件夹”).
export const libraryChoice = prefix => `${prefix}//label[span[@class='k-field-label' and contains(normalize-space(),'图库')]]//select`;
export const folderChoice = prefix => `${prefix}//label[span[@class='k-field-label' and normalize-space()='文件夹']]//select`;
// #113 (ADR-0008): no “current library” menu any more; the 图库 ＋ menu opens/creates/manages libraries.
export const libraryTrigger = "//button[@aria-label='打开、新建或管理图库']";
export const libraryMenu = "//*[@role='menu' and @aria-label='图库']";
