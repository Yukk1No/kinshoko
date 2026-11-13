// legacy-tag-names.mjs helpers: the fixture PNG and the old-schema library fixture.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chunk } from "./lib/fixtures.mjs";
export { chunk };

export const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
export function oldLibrary({ libraries, imagePath, oldSchema }, name, oldName) {
  const root = join(libraries, name);
  mkdirSync(root);
  const bytes = readFileSync(imagePath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rel = `originals/${sha.slice(0, 2)}/${sha}.png`;
  mkdirSync(join(root, "originals", sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(root, rel), bytes);
  const db = new DatabaseSync(join(root, "library.sqlite"));
  db.exec(oldSchema);
  const identity = (suffix) => createHash("sha256").update(name + suffix).digest("hex").slice(0, 32);
  const id = identity("library"), imageId = identity("image"), localId = identity("parted");
  db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id, name);
  db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at) VALUES (?,?,?,'png',?,3,3,1,'old.png',1000)").run(imageId, sha, bytes.length, rel);
  db.prepare("INSERT INTO tag VALUES (?,'general',1000)").run(localId);
  db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(localId, oldName);
  db.prepare("INSERT INTO tag_external VALUES ('parted_hair',?)").run(localId);
  db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId, localId);
  db.prepare("INSERT INTO tag_decision VALUES (?,?,'add',1000)").run(imageId, localId);
  db.close();
  return { info: { id, root, name }, imageId, localId, original: join(root, rel), sha };
}
