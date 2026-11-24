import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Section } from "../shell/Rail";
import { LoginExpiredNotice, useSubscriptionSection } from "./SubscriptionSection";
import { fakeBackend } from "../test/backend";

// 卸载时异步取消事件订阅，等它完成再撤掉模拟。

const account = { id: "1", name: "画师" };
const status = (over: object) => ({
  enabled: true,
  login: { state: "expired", account },
  signingIn: false,
  newCount: 0,
  checking: false,
  ...over,
});
const TITLE = "pixiv 登录已失效，检查已暂停";

function Host({ section = "browse", hidden = false }: { section?: Section; hidden?: boolean }) {
  const subscriptions = useSubscriptionSection(section, () => {});
  return <LoginExpiredNotice subscriptions={subscriptions} hidden={hidden} />;
}
const serve = (initial: object) => {
  const backend = fakeBackend({ subscription_status: status(initial), subscription_login: null });
  return { some: (match: (command: string) => boolean) => backend.calls().some((call) => match(call.command)) };
};

it("不在订阅页也提示，可以直接重新登录", async () => {
  const sent = serve({});
  render(<Host section="browse" />);
  await screen.findByText(TITLE);
  fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
  await waitFor(() => expect(sent.some((cmd) => cmd.endsWith("subscription_login"))).toBe(true));
});

it("订阅功能关着时不提示", async () => {
  const sent = serve({ enabled: false });
  render(<Host />);
  await waitFor(() => expect(sent.some((cmd) => cmd.endsWith("subscription_status"))).toBe(true));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.queryByText(TITLE)).toBeNull();
});

it("登录窗口开着时先收起", async () => {
  serve({ signingIn: true });
  render(<Host />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.queryByText(TITLE)).toBeNull();
});
