import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { fakeBackend } from "../test/backend";
import { AliasEditor } from "./TagAliasEditor";

function setup(save: () => Promise<null>) {
  const backend = fakeBackend({ vocabulary: { tags: [] }, add_tag_alias: save });
  const onError = vi.fn();
  render(
    <AliasEditor
      libraryId="A"
      tag={{ id: "1", namespace: "general", name: "blue eyes", untranslated: false, hasExternal: false }}
      generation={0}
      onError={onError}
      onClose={() => {}}
    />,
  );
  const input = screen.getByRole<HTMLInputElement>("textbox");
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加别名" });
  return { backend, onError, input, add };
}

it("keeps a rejected alias draft and allows retry while reporting the failure", async () => {
  const { input, add, onError } = setup(() => Promise.reject({ code: "system", detail: "disk full" }));
  fireEvent.change(input, { target: { value: "Glacier blue" } });
  fireEvent.click(add);
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(input.value).toBe("Glacier blue");
  expect(add.disabled).toBe(false);
});

it("clears an unchanged draft only after a successful save", async () => {
  let resolve!: (value: null) => void;
  const { input, add, backend } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.change(input, { target: { value: "  Glacier blue  " } });
  fireEvent.click(add);
  await waitFor(() => expect(backend.calls("add_tag_alias")).toHaveLength(1));
  expect(input.value).toBe("  Glacier blue  ");
  await act(async () => resolve(null));
  expect(input.value).toBe("");
  expect(add.disabled).toBe(true);
  expect(backend.calls("add_tag_alias")[0]).toMatchObject({ args: { alias: { name: "Glacier blue" } } });
});

it("does not clear a draft edited during a pending save", async () => {
  let resolve!: (value: null) => void;
  const { input, add, backend } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.change(input, { target: { value: "Glacier blue" } });
  fireEvent.click(add);
  await waitFor(() => expect(backend.calls("add_tag_alias")).toHaveLength(1));
  fireEvent.change(input, { target: { value: "Ocean blue" } });
  await act(async () => resolve(null));
  expect(input.value).toBe("Ocean blue");
  expect(add.disabled).toBe(false);
});

it("does not submit an empty or whitespace-only draft", () => {
  const { input, add, backend } = setup(() => Promise.resolve(null));
  expect(add.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(add.disabled).toBe(true);
  expect(backend.calls("add_tag_alias")).toHaveLength(0);
});
