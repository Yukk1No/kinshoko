import { act, fireEvent, waitFor, within } from "@testing-library/react";

/** 点开 Select，等它的列表出现（页面上可能同时开着 Combobox 的候选列表）。 */
async function open(trigger: HTMLElement) {
  fireEvent.click(trigger);
  return waitFor(() => {
    const list = document.querySelector<HTMLElement>(".k-select-popup[data-open] [role=listbox]");
    if (!list) throw new Error("Select 没有展开");
    return list;
  });
}

/** 在 Select（src/ui/Select.tsx）里选一项：点开触发器，再点名称为 `name` 的选项。 */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
  const list = await open(trigger);
  const option = within(list).getByRole("option", { name });
  // 真实的鼠标点击从选项上按下开始（Base UI 不认在别处按下、在选项上松开的点击）。
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option, { detail: 1 });
  await act(async () => {});
}

/** 在 Select 里按值选一项（选项的 `data-value`）。 */
export async function chooseValue(trigger: HTMLElement, value: string) {
  const list = await open(trigger);
  // 选项可能随后才读到（例如选了图库后才列出它的文件夹）。
  const option = await waitFor(() => {
    const found = list.querySelector<HTMLElement>(`[data-value="${value}"]`);
    if (!found) throw new Error(`没有值为 ${value} 的选项`);
    return found;
  });
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.click(option, { detail: 1 });
  await act(async () => {});
}

/** 展开 Select 读出各项名称，再收起。 */
export async function optionNames(trigger: HTMLElement) {
  const list = await open(trigger);
  const names = within(list).getAllByRole("option").map((o) => o.textContent ?? "");
  fireEvent.keyDown(document.activeElement ?? list, { key: "Escape" });
  await act(async () => {});
  return names;
}
