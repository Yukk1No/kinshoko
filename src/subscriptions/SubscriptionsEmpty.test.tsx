import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SubscriptionsEmpty } from "./SubscriptionsEmpty";

it("取消登录后不把焦点留给同一位置的风险说明按钮", () => {
  const setFirstRun = vi.fn();
  function PendingLogin() {
    const [signingIn, setSigningIn] = useState(true);
    return (
      <SubscriptionsEmpty
        signingIn={signingIn}
        actions={{ cancel: () => setSigningIn(false), signIn: vi.fn(), signOut: vi.fn() }}
        setFirstRun={setFirstRun}
      />
    );
  }
  render(<PendingLogin />);
  const cancel = screen.getByRole("button", { name: "取消" });
  cancel.focus();
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  const risks = screen.getByRole("button", { name: "风险说明" });
  expect(risks).not.toBe(cancel);
  expect(cancel.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(risks);
  expect(setFirstRun).not.toHaveBeenCalled();
  fireEvent.click(risks);
  expect(setFirstRun).toHaveBeenCalledWith(true);
});
