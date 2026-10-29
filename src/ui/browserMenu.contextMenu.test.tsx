import { ContextMenu } from "@base-ui/react/context-menu";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { blockBrowserMenu } from "./browserMenu";

let stop = () => {};
afterEach(() => stop());

it("装了拦截以后，Base UI 的右键菜单照样能打开（图片墙、截图历史）", async () => {
  stop = blockBrowserMenu(window);
  render(
    <ContextMenu.Root>
      <ContextMenu.Trigger>卡片</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup>
            <ContextMenu.Item>复制</ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>,
  );
  fireEvent.contextMenu(screen.getByText("卡片"));
  expect(await screen.findByText("复制")).toBeTruthy();
});
