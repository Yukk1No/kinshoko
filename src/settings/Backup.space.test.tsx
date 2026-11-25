import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupSettings } from "./Backup";
import { backend, narrowed, withTarget } from "./Backup.fixtures";

describe("备份位置空间", () => {
  it("空间不足时提示，仍可开始备份", async () => {
    const fake = backend({
      backup_status: withTarget,
      backup_preview: { ...narrowed, targetFreeBytes: 0 },
      start_backup: null,
    });
    render(<BackupSettings />);
    const warning = await screen.findByText(/备份位置空间不足/);
    expect(warning.className).toBe("k-list-desc is-warn");
    expect(warning.querySelector(".k-warn-icon")).not.toBeNull();
    const start = screen.getByRole<HTMLButtonElement>("button", { name: "备份" });
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(fake.calls("start_backup")).toHaveLength(1));
  });

  it.each([null, narrowed.estimate.newBytes, narrowed.estimate.newBytes + 1])(
    "剩余空间为 %s 时不提示空间不足",
    async (targetFreeBytes) => {
      backend({ backup_status: withTarget, backup_preview: { ...narrowed, targetFreeBytes } });
      render(<BackupSettings />);
      await screen.findByText(/新原图 1 张/);
      expect(screen.queryByText(/备份位置空间不足/)).toBeNull();
    },
  );
});
