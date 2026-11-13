import { expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { fakeBackend } from "../test/backend";
import { SaveDestinationProvider } from "./SaveDestination";
import { useImportRecovery } from "./useImportRecovery";


const interrupted = (path: string): RecoveryReport => ({ interrupted: [path], orphans: [], discardedStaging: 0 });
const clean: RecoveryReport = { interrupted: [], orphans: [], discardedStaging: 0 };

function Probe() {
  const { recovery } = useImportRecovery();
  return <p role="status">{recovery?.report.interrupted.join() ?? "无"}</p>;
}

/** 假后端：`registered` 决定登记了什么，`answers` 依次回答读对账结果的请求。 */
function backend(answers: (RecoveryReport | Promise<RecoveryReport>)[]) {
  const state = { registered: true, revision: 0 };
  fakeBackend({
    workspace_directories: () => {
      const registration = { library: { id: "L1", name: "参考", root: "D:/参考" }, unavailable: null };
      const providers = state.registered ? [{ registration, unassigned: 0, descendants: {}, sidebar: null }] : [];
      return { status: { revision: String(state.revision), libraries: providers.map((p) => p.registration) }, providers };
    },
    recovery: () => answers.shift(),
  });
  const setRegistered = (registered: boolean) => act(async () => {
    state.registered = registered;
    state.revision += 1;
    await emit("workspace-changed", { revision: String(state.revision), libraries: [] });
  });
  return { setRegistered };
}

it("取消登记后再登记，不再提示上一次打开时的中断", async () => {
  const { setRegistered } = backend([interrupted("D:/旧.png"), clean]);
  render(<SaveDestinationProvider safe={false}><Probe /></SaveDestinationProvider>);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("D:/旧.png"));

  await setRegistered(false);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("无"));
  await setRegistered(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(screen.getByRole("status").textContent).toBe("无");
});

it("取消登记前发出的读取，结果不算到重新登记后的资料库", async () => {
  let answerOld: (report: RecoveryReport) => void = () => {};
  const { setRegistered } = backend([new Promise((resolve) => { answerOld = resolve; }), clean]);
  render(<SaveDestinationProvider safe={false}><Probe /></SaveDestinationProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  await setRegistered(false);
  await setRegistered(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { answerOld(interrupted("D:/旧.png")); await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(screen.getByRole("status").textContent).toBe("无");
});
