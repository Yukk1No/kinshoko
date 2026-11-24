import { expect, it } from "vitest";
import { backend, defaults } from "../settings/SettingsPanel.fixtures";
import { createShellSettings } from "./useShellSettings";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = (settings: ReturnType<typeof createShellSettings>) =>
  settings.state().densityDraft ?? settings.state().view?.wallDensity ?? 240;

it("keeps the latest optimistic size over earlier density replies", async () => {
  const replies: (() => void)[] = [];
  backend({
    "change_setting:wallDensity": (args) =>
      new Promise((resolve) => {
        replies.push(() => resolve({ ...defaults, wallDensity: args.density }));
      }),
  });
  const settings = createShellSettings();
  expect(shown(settings)).toBe(240);
  await settings.load();
  settings.changeWallDensity(300);
  settings.changeWallDensity(330);
  replies.shift()!();
  await tick();
  expect(shown(settings)).toBe(330);
  replies.shift()!();
  await tick();
  expect(shown(settings)).toBe(330);
  expect(settings.state().densityDraft).toBeNull();
});

it("keeps the chosen size usable when saving fails", async () => {
  backend({ "change_setting:wallDensity": () => Promise.reject("cannot save") });
  const settings = createShellSettings();
  await settings.load();
  settings.changeWallDensity(330);
  await tick();
  expect(shown(settings)).toBe(330);
  expect(settings.state().view?.wallDensity).toBe(240);
  expect(settings.state().error).toBeNull();
});

it("lets an explicit restore replace an earlier choice but not a choice made after it", async () => {
  const replies: (() => void)[] = [];
  backend({
    "change_setting:wallDensity": (args) =>
      new Promise((resolve) => {
        replies.push(() => resolve({ ...defaults, wallDensity: args.density }));
      }),
    restore_application_settings: () => ({
      settings: { ...defaults, wallDensity: 180 },
      safeMode: true,
      problems: [],
    }),
  });
  const settings = createShellSettings();
  await settings.load();
  settings.changeWallDensity(300);
  const first = settings.restore("backup", "fingerprint");
  replies.shift()!();
  await first;
  expect(shown(settings)).toBe(180);
  const second = settings.restore("backup", "fingerprint");
  settings.changeWallDensity(330);
  await second;
  expect(shown(settings)).toBe(330);
  replies.shift()!();
  await tick();
  expect(shown(settings)).toBe(330);
  expect(settings.state().densityDraft).toBeNull();
});
