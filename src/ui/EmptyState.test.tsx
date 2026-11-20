import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Search } from "lucide-react";
import { EmptyState } from "./EmptyState";

it("整页只有一个标题，说明与操作可选，图标不被读出", () => {
  const { rerender } = render(<EmptyState size="page" title="没有符合条件的参考图。" icon={<Search />} />);
  expect(screen.getByRole("heading").textContent).toBe("没有符合条件的参考图。");
  expect(document.querySelector(".k-empty-hint")).toBeNull();
  expect(document.querySelector(".k-empty-actions")).toBeNull();
  expect(document.querySelector(".k-empty-icon")?.getAttribute("aria-hidden")).toBe("true");
  rerender(
    <EmptyState
      size="page"
      title="登录"
      hint="账号风险"
      icon={<Search />}
      actions={<button type="button">继续</button>}
    />,
  );
  expect(screen.getByText("账号风险").className).toBe("k-empty-hint");
  expect(screen.getByRole("button").parentElement?.className).toBe("k-empty-actions");
});

it("列表内保留列表语义，空说明和重复说明不另占一行", () => {
  const { rerender } = render(
    <ul>
      <EmptyState as="li" size="list" title="还没有标签" />
    </ul>,
  );
  expect(screen.getByRole("listitem").textContent).toBe("还没有标签");
  expect(screen.queryByRole("heading")).toBeNull();
  expect(document.querySelector(".k-empty-icon")).toBeNull();
  rerender(<EmptyState size="page" title="正在打开图库…" hint="正在打开图库…" role="status" icon={<Search />} />);
  expect(screen.getByRole("status").textContent).toBe("正在打开图库…");
  expect(document.querySelector(".k-empty-hint")).toBeNull();
});
