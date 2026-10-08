import { useEffect, useState } from "react";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { pickFolder, registeredLibraries, registerLibrary, switchLibrary, unregisterLibrary } from "../ipc";

/** 本设备的资料库登记、切换与取消登记。不可用的登记仍可重试或取消。 */
export function LibraryPicker({ current, onChanged, onCreate, blocked = false, compact = false }: {
  current: LibraryInfo | null | undefined;
  onChanged: (library: LibraryInfo | null) => void;
  onCreate: () => void;
  blocked?: boolean;
  compact?: boolean;
}) {
  const [entries, setEntries] = useState<LibraryRegistration[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const disabled = busy || blocked || current === undefined;

  useEffect(() => {
    if (current === undefined) return;
    let alive = true;
    registeredLibraries().then(
      (value) => alive && setEntries(value),
      (e) => alive && setError(String(e)),
    );
    return () => { alive = false; };
  }, [current?.id, current?.root, current === undefined, revision]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { setError(String(e)); }
    finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };

  const register = () => run(async () => {
    const root = await pickFolder();
    if (root) onChanged(await registerLibrary(root));
  });
  const remove = (id: string) => run(async () => {
    await unregisterLibrary(id);
    if (current?.id === id) onChanged(null);
  });

  return (
    <section className="library-manager" aria-label="资料库管理">
      <div className="library-actions">
        <label>
          当前资料库
          <select aria-label="当前资料库" value={current?.id ?? ""} disabled={disabled}
            onChange={(e) => { const id = e.target.value; if (id) void run(async () => onChanged(await switchLibrary(id))); }}>
            <option value="">{current === undefined ? "正在打开…" : "尚未打开"}</option>
            {entries.map(({ library, unavailable }) => (
              <option key={library.id} value={library.id}>
                {library.name}{unavailable ? "（暂时不可用）" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="library-tools" open={compact ? undefined : true}>
        <summary>资料库操作</summary>
        <div className="library-tools-actions">
        <button type="button" disabled={disabled} onClick={() => void register()}>登记已有资料库…</button>
        <button type="button" disabled={disabled} onClick={onCreate}>新建资料库…</button>
        <button type="button" disabled={disabled} onClick={() => setRevision((value) => value + 1)}>刷新登记</button>
        {busy && <span role="status">正在处理资料库，等待旧库任务结束…</span>}
      </div>
      <p className="library-switch-notice">切换或取消当前登记时会取消未完成的导入，已成功的图片保留。</p>
      {error && <p role="alert">{error}</p>}
      {entries.length > 0 && (
        <details className="library-registrations" open>
          <summary>本设备登记的资料库</summary>
          <ul>
            {entries.map(({ library, unavailable }) => (
              <li key={library.id}>
                <span>{library.name} · {library.root}</span>
                <button type="button" disabled={disabled} aria-label={`取消登记 ${library.name}`}
                  title="只取消本设备的登记，原图和整理结果仍保存在原位置"
                  onClick={() => void remove(library.id)}>取消登记</button>
                {unavailable && <p role="status">{unavailable}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      </details>
    </section>
  );
}
