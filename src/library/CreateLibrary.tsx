import { useState } from "react";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import { createLibrary, pickFolder } from "../ipc";

/** 建立资料库：起名、选择存放位置，在那里新建同名文件夹，登记到本设备并打开。 */
export function CreateLibrary({ onCreated }: { onCreated: (library: LibraryInfo) => void }) {
  const [name, setName] = useState("我的参考");
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const picked = await pickFolder();
    if (picked) setParent(picked);
  };

  const create = async () => {
    if (!parent) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createLibrary(parent, name.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="create-library" aria-labelledby="create-library-title">
      <h1 id="create-library-title">建立资料库</h1>
      <p>资料库会在所选位置新建一个同名文件夹，原图和整理结果都存放在里面。</p>
      <label>
        资料库名称
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="create-library-location">
        <button type="button" onClick={choose}>
          选择存放位置…
        </button>
        <span className="create-library-path">{parent ?? "尚未选择"}</span>
      </div>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="primary"
        disabled={!parent || !name.trim() || busy}
        onClick={create}
      >
        建立资料库
      </button>
    </section>
  );
}
