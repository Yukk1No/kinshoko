"""PROTOTYPE — 资料库与参考组持久化的候选实现（#8），用完可弃。

候选格式（docs/discovery/data-storage-model.md）：
  资料库目录 = library.sqlite（库身份 + 全部整理数据）+ originals/<sha[:2]>/<sha>.<ext>
  参考组     = 独立的带版本 JSON
  设备登记   = device.json（库与组的位置）
值得留下的是表结构、身份规则和各操作的顺序；Python 只是为了跑得快。

故障注入：环境变量 KINSHOKO_FAULT=<点名>@<第几次> 让进程在该点直接 os._exit，模拟断电／被杀。
"""
import hashlib, json, math, os, shutil, sqlite3, time, uuid, zipfile

FORMAT_VERSION = 1
GROUP_FORMAT = "kinshoko.reference-group"
GROUP_FORMAT_VERSION = 1
PACKAGE_FORMAT = "kinshoko.reference-group-package"
BACKUP_FORMAT = "kinshoko.backup"
MAPPING_VERSION = 1  # Eagle 字段映射版本

_fault_hits = {}


def fault(name):
    spec = os.environ.get("KINSHOKO_FAULT", "")
    fname, _, n = spec.partition("@")
    if fname != name:
        return
    _fault_hits[name] = _fault_hits.get(name, 0) + 1
    if _fault_hits[name] >= int(n or 1):
        os._exit(99)


def new_id():
    return uuid.uuid4().hex


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def fsync_write(path, data):
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def lp(path):
    """Windows 长路径：备份内的 库ID/originals/xx/哈希 层级很容易超过 260 字符。"""
    path = os.path.abspath(path)
    prefix = "\\\\?\\"
    return prefix + path if os.name == "nt" and not path.startswith(prefix) else path


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def image_size(data):
    """原型只认 PNG 头；正式实现须解码并处理 EXIF 方向。"""
    if data[1:4] == b"PNG":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return None, None


class ItemError(Exception):
    pass


SCHEMA = """
CREATE TABLE library(id TEXT PRIMARY KEY, name TEXT NOT NULL, format_version INTEGER NOT NULL, created_at TEXT);
CREATE TABLE image(
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, ext TEXT, width INTEGER, height INTEGER,
  rel_path TEXT NOT NULL, original_name TEXT, note_manual TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','trashed')),
  previous_image_id TEXT REFERENCES image(id), created_at TEXT);
CREATE INDEX image_sha ON image(sha256);
CREATE TABLE tag(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE folder(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folder(id), source_key TEXT UNIQUE, ord INTEGER);
-- 来源给出的标签／文件夹归属；同一来源重导时整体刷新
CREATE TABLE assertion(image_id TEXT NOT NULL REFERENCES image(id), kind TEXT NOT NULL CHECK(kind IN ('tag','folder')),
  key TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(image_id, kind, key, source));
-- 人工决定；重导从不触碰
CREATE TABLE manual_decision(image_id TEXT NOT NULL REFERENCES image(id), kind TEXT NOT NULL, key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('add','reject')), decided_at TEXT, PRIMARY KEY(image_id, kind, key));
CREATE TABLE import_source(id TEXT PRIMARY KEY, kind TEXT NOT NULL, location TEXT, raw_library_json TEXT,
  mapping_version INTEGER, registered_at TEXT, relocated_from TEXT);
-- 外部项 ↔ 图片记录；外部项换内容时旧绑定 superseded，新内容成为新图片记录
CREATE TABLE source_binding(source_id TEXT NOT NULL REFERENCES import_source(id), external_id TEXT NOT NULL,
  sha256 TEXT NOT NULL, image_id TEXT NOT NULL REFERENCES image(id), raw_item_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('present','trashed','missing','superseded')), last_run TEXT,
  PRIMARY KEY(source_id, external_id, sha256));
CREATE TABLE region_note(id TEXT PRIMARY KEY, image_id TEXT NOT NULL REFERENCES image(id), source TEXT NOT NULL,
  external_id TEXT, x REAL, y REAL, w REAL, h REAL, basis TEXT, text TEXT, raw_json TEXT);
CREATE TABLE import_run(id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','ok','partial','interrupted','failed')), report_json TEXT);
CREATE TABLE import_failure(run_id TEXT NOT NULL, external_id TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE restore_provenance(old_library_id TEXT, backup_id TEXT, restored_at TEXT);
"""

# 原样往返比较时要归一化的、本来就应该变化的东西
VOLATILE_TABLES = {"restore_provenance"}


class Library:
    def __init__(self, path):
        self.path = path
        self.fpath = lp(path)  # 文件操作用长路径形式
        self.db = sqlite3.connect(os.path.join(path, "library.sqlite"), isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")

    def file(self, rel):
        return os.path.join(self.fpath, *rel.split("/"))

    @classmethod
    def create(cls, path, name):
        os.makedirs(os.path.join(path, "originals"), exist_ok=True)
        lib = cls(path)
        lib.db.executescript(SCHEMA)
        lib.db.execute("INSERT INTO library VALUES(?,?,?,?)", (new_id(), name, FORMAT_VERSION, now()))
        return lib

    def close(self):
        self.db.close()

    @property
    def id(self):
        return self.db.execute("SELECT id FROM library").fetchone()[0]

    @property
    def name(self):
        return self.db.execute("SELECT name FROM library").fetchone()[0]

    def q(self, sql, *a):
        return self.db.execute(sql, a).fetchall()

    def one(self, sql, *a):
        r = self.db.execute(sql, a).fetchone()
        return r[0] if r else None

    # ---------- 打开时的自检 ----------
    def recover(self):
        """上次进程中途退出后再打开：标记未完成导入，报告暂存与孤立原文件（不删除）。"""
        interrupted = [r[0] for r in self.q("SELECT id FROM import_run WHERE status='running'")]
        for rid in interrupted:
            self.db.execute("UPDATE import_run SET status='interrupted', finished_at=? WHERE id=?", (now(), rid))
        staging = os.path.join(self.fpath, ".staging")
        leftover = os.listdir(staging) if os.path.isdir(staging) else []
        for f in leftover:
            os.remove(os.path.join(staging, f))  # 暂存文件尚未发布，删了也不影响来源
        return {"interrupted_runs": interrupted, "staging_cleaned": len(leftover), "orphan_originals": self.orphans()}

    def orphans(self):
        known = {r[0] for r in self.q("SELECT rel_path FROM image")}
        out = []
        for d, _, files in os.walk(os.path.join(self.fpath, "originals")):
            for f in files:
                rel = os.path.relpath(os.path.join(d, f), self.fpath).replace("\\", "/")
                if rel not in known:
                    out.append(rel)
        return sorted(out)

    def verify(self):
        problems = []
        for iid, rel, sha in self.q("SELECT id, rel_path, sha256 FROM image"):
            p = self.file(rel)
            if not os.path.exists(p):
                problems.append(("missing_original", iid))
            elif sha256_file(p) != sha:
                problems.append(("content_mismatch", iid))
        return problems

    # ---------- 原文件发布 ----------
    def _publish(self, data, sha, ext):
        rel = f"originals/{sha[:2]}/{sha}.{ext}"
        dst = self.file(rel)
        if os.path.exists(dst):
            if sha256_file(dst) == sha:
                return rel, "reused"  # 上次中断留下的已发布文件，直接复用
            raise ItemError("library_file_conflict")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        staging = os.path.join(self.fpath, ".staging")
        os.makedirs(staging, exist_ok=True)
        tmp = os.path.join(staging, new_id())
        fsync_write(tmp, data)
        if sha256_file(tmp) != sha:
            raise ItemError("staging_verify_failed")
        os.replace(tmp, dst)
        return rel, "published"

    # ---------- 来源 ----------
    def _tag_id(self, name):
        tid = self.one("SELECT id FROM tag WHERE name=?", name)
        if tid is None:
            tid = new_id()
            self.db.execute("INSERT INTO tag VALUES(?,?)", (tid, name))
        return tid

    def relocation_candidate(self, kind, location, external_ids):
        """新位置疑似是已登记来源搬家：同类来源的已绑定外部 ID 至少一半出现在新位置。只提出候选，不改任何数据。"""
        loc = os.path.normcase(os.path.abspath(location))
        if self.one("SELECT id FROM import_source WHERE kind=? AND location=?", kind, loc):
            return None
        best, best_ratio = None, 0.0
        for (cand,) in self.q("SELECT id FROM import_source WHERE kind=?", kind):
            ids = {r[0] for r in self.q("SELECT external_id FROM source_binding WHERE source_id=?", cand)}
            if ids:
                ratio = len(ids & external_ids) / len(ids)
                if ratio > best_ratio:
                    best, best_ratio = cand, ratio
        if best and best_ratio >= 0.5:
            return {"source_id": best, "from": self.one("SELECT location FROM import_source WHERE id=?", best), "to": loc,
                    "overlap": round(best_ratio, 3)}
        return None

    def _resolve_source(self, kind, location, source=None):
        """source：None＝按位置找或新登记；已登记来源的 ID＝用户确认是它搬了家；"new"＝用户确认是另一个来源。"""
        loc = os.path.normcase(os.path.abspath(location))
        if source not in (None, "new"):
            old = self.one("SELECT location FROM import_source WHERE id=?", source)
            if old is None:
                raise RuntimeError("确认的来源不存在：" + source)
            if old != loc:
                self.db.execute("UPDATE import_source SET location=?, relocated_from=? WHERE id=?", (loc, old, source))
                return source, {"from": old, "to": loc}
            return source, None
        sid = None if source == "new" else self.one("SELECT id FROM import_source WHERE kind=? AND location=?", kind, loc)
        if sid:
            return sid, None
        sid = new_id()
        self.db.execute("INSERT INTO import_source VALUES(?,?,?,?,?,?,?)", (sid, kind, loc, None, MAPPING_VERSION, now(), None))
        return sid, None

    def _ingest(self, src, external_id, data, *, ext, width, height, name, raw, state, tags, folder_keys, comments, run_id):
        """导入一项。返回结果类别。每项一个事务；原文件先于事务发布。"""
        sha = sha256_bytes(data)
        bound = self.one("SELECT image_id FROM source_binding WHERE source_id=? AND external_id=? AND sha256=?", src, external_id, sha)
        prev = self.q("SELECT image_id, sha256 FROM source_binding WHERE source_id=? AND external_id=? AND sha256<>? AND state<>'superseded'",
                      src, external_id, sha)
        new_image = None
        if bound:
            image_id, outcome = bound, "refreshed"
        else:
            same = self.one("SELECT id FROM image WHERE sha256=? ORDER BY created_at LIMIT 1", sha)
            if same:
                image_id, outcome = same, "merged_same_original"
            else:
                rel, how = self._publish(data, sha, ext)
                fault("import_after_publish")
                image_id = new_id()
                outcome = "new_version" if prev else ("created_reused_file" if how == "reused" else "created")
                new_image = (image_id, sha, len(data), ext, width, height, rel, name, None,
                             "trashed" if state == "trashed" else "active", prev[0][0] if prev else None, now())
        source_tag = f"{src}:{external_id}"
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if new_image:
                self.db.execute("INSERT INTO image VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", new_image)
            for old_image, old_sha in prev:
                self.db.execute("UPDATE source_binding SET state='superseded' WHERE source_id=? AND external_id=? AND sha256=?",
                                (src, external_id, old_sha))
            self.db.execute("INSERT OR REPLACE INTO source_binding VALUES(?,?,?,?,?,?,?)",
                            (src, external_id, sha, image_id, raw, state, run_id))
            self.db.execute("DELETE FROM assertion WHERE image_id=? AND source=?", (image_id, source_tag))
            for t in tags:
                self.db.execute("INSERT OR IGNORE INTO assertion VALUES(?,?,?,?)", (image_id, "tag", self._tag_id(t), source_tag))
            dangling = []
            for fk in folder_keys:
                fid = self.one("SELECT id FROM folder WHERE source_key=?", f"{src}:{fk}")
                if fid:
                    self.db.execute("INSERT OR IGNORE INTO assertion VALUES(?,?,?,?)", (image_id, "folder", fid, source_tag))
                else:
                    dangling.append(fk)
            self.db.execute("DELETE FROM region_note WHERE image_id=? AND source=?", (image_id, source_tag))
            for c in comments:
                self.db.execute("INSERT INTO region_note VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                                (new_id(), image_id, source_tag, c.get("id"), c.get("x"), c.get("y"), c.get("width"), c.get("height"),
                                 "eagle-raw-unverified", c.get("annotation"), dumps(c)))
            fault("import_before_commit")
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return outcome, dangling

    def _upsert_folders(self, src, folders, parent=None):
        for i, f in enumerate(folders):
            key = f"{src}:{f['id']}"
            fid = self.one("SELECT id FROM folder WHERE source_key=?", key)
            if fid:
                self.db.execute("UPDATE folder SET name=?, parent_id=?, ord=? WHERE id=?", (f["name"], parent, i, fid))
            else:
                fid = new_id()
                self.db.execute("INSERT INTO folder VALUES(?,?,?,?,?)", (fid, f["name"], parent, key, i))
            self._upsert_folders(src, f.get("children", []), fid)

    def _start_run(self, src):
        rid = new_id()
        self.db.execute("INSERT INTO import_run VALUES(?,?,?,?,?,?)", (rid, src, now(), None, "running", None))
        return rid

    def _finish_run(self, rid, report):
        status = "partial" if report["failed"] else "ok"
        report["status"] = status
        self.db.execute("BEGIN")
        self.db.execute("UPDATE import_run SET status=?, finished_at=?, report_json=? WHERE id=?", (status, now(), dumps(report), rid))
        for ext_id, reason in report["failures"]:
            self.db.execute("INSERT INTO import_failure VALUES(?,?,?)", (rid, ext_id, reason))
        self.db.execute("COMMIT")
        return report

    # ---------- Eagle 导入 ----------
    def import_eagle(self, eagle_dir, source=None):
        """source 见 _resolve_source。新位置疑似已登记来源搬家且未指定 source 时，不写任何数据，返回待确认。"""
        try:
            root_meta = json.load(open(os.path.join(eagle_dir, "metadata.json"), encoding="utf-8"))
            mt = json.load(open(os.path.join(eagle_dir, "mtime.json"), encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise RuntimeError(f"不是可读的 Eagle 资料库：{e}")
        if not str(root_meta.get("applicationVersion", "")).startswith("4."):
            raise RuntimeError("未支持的 Eagle 版本：" + str(root_meta.get("applicationVersion")))
        index_ids = {k for k in mt if k != "all"}
        img_dir = os.path.join(eagle_dir, "images")
        dir_ids = {d[:-5] for d in os.listdir(img_dir) if d.endswith(".info")} if os.path.isdir(img_dir) else set()
        all_ids = index_ids | dir_ids
        if source is None:
            cand = self.relocation_candidate("eagle", eagle_dir, all_ids)
            if cand:
                return {"status": "needs_confirmation", "candidate": cand}
        src, relocated = self._resolve_source("eagle", eagle_dir, source)
        self.db.execute("BEGIN")
        self.db.execute("UPDATE import_source SET raw_library_json=? WHERE id=?", (dumps(root_meta), src))
        self._upsert_folders(src, root_meta.get("folders", []))
        self.db.execute("COMMIT")
        rid = self._start_run(src)
        report = {"run_id": rid, "source_id": src, "relocated": relocated, "seen": len(all_ids), "ok": 0, "failed": 0,
                  "outcomes": {}, "failures": [], "dangling_folders": [],
                  "index_only": sorted(index_ids - dir_ids), "dir_only": sorted(dir_ids - index_ids)}
        for iid in sorted(all_ids):
            try:
                outcome, dangling = self._import_eagle_item(src, eagle_dir, iid, rid)
                report["ok"] += 1
                report["outcomes"][outcome] = report["outcomes"].get(outcome, 0) + 1
                report["dangling_folders"] += [(iid, d) for d in dangling]
            except ItemError as e:
                report["failed"] += 1
                report["failures"].append((iid, str(e)))
        # 枚举中已经看不到的外部项：标记缺失，不删除本库副本
        gone = [r[0] for r in self.q("SELECT external_id FROM source_binding WHERE source_id=? AND state IN ('present','trashed')", src)
                if r[0] not in all_ids]
        self.db.execute("BEGIN")
        for g in gone:
            self.db.execute("UPDATE source_binding SET state='missing' WHERE source_id=? AND external_id=? AND state IN ('present','trashed')", (src, g))
        self.db.execute("COMMIT")
        report["marked_missing"] = gone
        return self._finish_run(rid, report)

    def _import_eagle_item(self, src, eagle_dir, iid, rid):
        d = os.path.join(eagle_dir, "images", iid + ".info")
        mp = os.path.join(d, "metadata.json")
        if not os.path.exists(mp):
            raise ItemError("missing_json")
        try:
            meta = json.load(open(mp, encoding="utf-8"))
        except ValueError:
            raise ItemError("bad_json")
        if meta.get("id") != iid:
            raise ItemError("id_mismatch")
        orig = os.path.join(d, f"{meta.get('name')}.{meta.get('ext')}")
        if not os.path.exists(orig):
            thumb = os.path.exists(os.path.join(d, f"{meta.get('name')}_thumbnail.png"))
            raise ItemError("missing_original" + ("（只剩缩略图）" if thumb else ""))
        data = open(orig, "rb").read()
        if meta.get("size") is not None and meta["size"] != len(data):
            raise ItemError(f"size_mismatch（记录 {meta['size']}，实际 {len(data)}）")
        return self._ingest(src, iid, data, ext=meta.get("ext"), width=meta.get("width"), height=meta.get("height"),
                            name=meta.get("name"), raw=dumps(meta), state="trashed" if meta.get("isDeleted") else "present",
                            tags=meta.get("tags", []), folder_keys=meta.get("folders", []), comments=meta.get("comments", []),
                            run_id=rid)

    # ---------- 普通文件导入 ----------
    def import_files(self, paths):
        src, _ = self._resolve_source("files", os.path.dirname(paths[0]))
        rid = self._start_run(src)
        report = {"run_id": rid, "source_id": src, "relocated": None, "seen": len(paths), "ok": 0, "failed": 0,
                  "outcomes": {}, "failures": [], "dangling_folders": []}
        for p in paths:
            try:
                data = open(p, "rb").read()
                w, h = image_size(data)
                outcome, _ = self._ingest(src, os.path.basename(p), data, ext=p.rsplit(".", 1)[-1], width=w, height=h,
                                          name=os.path.basename(p).rsplit(".", 1)[0], raw=dumps({"path": p}), state="present",
                                          tags=[], folder_keys=[], comments=[], run_id=rid)
                report["ok"] += 1
                report["outcomes"][outcome] = report["outcomes"].get(outcome, 0) + 1
            except (OSError, ItemError) as e:
                report["failed"] += 1
                report["failures"].append((p, str(e)))
        return self._finish_run(rid, report)

    # ---------- 人工整理 ----------
    def decide_tag(self, image_id, tag, decision):
        self.db.execute("INSERT OR REPLACE INTO manual_decision VALUES(?,?,?,?,?)", (image_id, "tag", self._tag_id(tag), decision, now()))

    def set_note(self, image_id, text):
        self.db.execute("UPDATE image SET note_manual=? WHERE id=?", (text, image_id))

    def set_status(self, image_id, status):
        self.db.execute("UPDATE image SET status=? WHERE id=?", (status, image_id))

    def image_by_external(self, external_id, current=True):
        return self.one("SELECT image_id FROM source_binding WHERE external_id=?" + (" AND state<>'superseded'" if current else ""), external_id)

    # ---------- 查看 ----------
    def effective(self, image_id, kind):
        auto = {r[0] for r in self.q("SELECT key FROM assertion WHERE image_id=? AND kind=?", image_id, kind)}
        dec = dict(self.q("SELECT key, decision FROM manual_decision WHERE image_id=? AND kind=?", image_id, kind))
        keys = (auto - {k for k, v in dec.items() if v == "reject"}) | {k for k, v in dec.items() if v == "add"}
        if kind == "tag":
            return sorted(self.one("SELECT name FROM tag WHERE id=?", k) for k in keys)
        return sorted(self.folder_path(k) for k in keys)

    def folder_path(self, fid):
        parts = []
        while fid:
            name, fid = self.db.execute("SELECT name, parent_id FROM folder WHERE id=?", (fid,)).fetchone()
            parts.append(name)
        return "/".join(reversed(parts))

    def image_view(self, image_id):
        r = self.db.execute("SELECT id, sha256, size, ext, width, height, rel_path, original_name, note_manual, status, previous_image_id "
                            "FROM image WHERE id=?", (image_id,)).fetchone()
        keys = ["id", "sha256", "size", "ext", "width", "height", "rel_path", "original_name", "note_manual", "status", "previous_image_id"]
        v = dict(zip(keys, r))
        v["tags_effective"] = self.effective(image_id, "tag")
        v["folders_effective"] = self.effective(image_id, "folder")
        v["manual_decisions"] = sorted((self.one("SELECT name FROM tag WHERE id=?", k), d)
                                       for k, d in self.q("SELECT key, decision FROM manual_decision WHERE image_id=? AND kind='tag'", image_id))
        v["bindings"] = sorted(({"source": s, "external_id": e, "state": st, "raw": json.loads(raw)}
                                for s, e, st, raw in self.q("SELECT source_id, external_id, state, raw_item_json FROM source_binding WHERE image_id=?", image_id)),
                               key=lambda b: (b["source"], b["external_id"]))
        v["region_notes"] = sorted(({"external_id": e, "x": x, "y": y, "w": w, "h": h, "text": t, "raw": json.loads(raw)}
                                    for e, x, y, w, h, t, raw in self.q("SELECT external_id, x, y, w, h, text, raw_json FROM region_note WHERE image_id=?", image_id)),
                                   key=lambda n: str(n["external_id"]))
        return v

    def canonical_dump(self):
        """全表按内容排序导出；库身份归一化，用于往返逐字比较。"""
        out = {}
        for (t,) in self.q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            if t in VOLATILE_TABLES:
                continue
            rows = [list(r) for r in self.q(f"SELECT * FROM {t}")]
            if t == "library":
                rows = [["<library_id>"] + r[1:] for r in rows]
            out[t] = sorted(rows, key=dumps)
        return out


# ====================== 参考组 ======================

def new_group(name):
    return {"format": GROUP_FORMAT, "format_version": GROUP_FORMAT_VERSION, "group_id": new_id(), "name": name,
            "viewport": {"x": 0, "y": 0, "zoom": 1.0}, "members": []}


def add_member(group, lib, image_id, crop=None, x=0, y=0, scale=1.0):
    sha, w, h = lib.db.execute("SELECT sha256, width, height FROM image WHERE id=?", (image_id,)).fetchone()
    m = {"member_id": new_id(), "source": {"library_id": lib.id, "image_id": image_id}, "expected_sha256": sha,
         "source_size": {"w": w, "h": h}, "crop": crop or "whole", "x": x, "y": y, "scale": scale}
    group["members"].append(m)
    return m


def validate_group(g):
    problems = []
    if g.get("format") != GROUP_FORMAT or g.get("format_version") != GROUP_FORMAT_VERSION:
        problems.append("unknown_format_version")
    ids = [m["member_id"] for m in g.get("members", [])]
    if len(ids) != len(set(ids)):
        problems.append("duplicate_member_id")
    for m in g.get("members", []):
        nums = [m["x"], m["y"], m["scale"]]
        c = m["crop"]
        if c != "whole":
            nums += [c["x"], c["y"], c["w"], c["h"]]
            sw, sh = m["source_size"]["w"], m["source_size"]["h"]
            if not (sw and sh):
                problems.append(f"crop_without_source_size:{m['member_id']}")
            elif (c["x"] < 0 or c["y"] < 0 or c["x"] + c["w"] > sw or c["y"] + c["h"] > sh or c["w"] <= 0 or c["h"] <= 0):
                problems.append(f"crop_out_of_bounds:{m['member_id']}")
        if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in nums) or m["scale"] <= 0:
            problems.append(f"bad_number:{m['member_id']}")
    return problems


def save_group(path, g):
    """先写临时文件并落盘，再原子替换；中断时旧版本保持完整。"""
    if validate_group(g):
        raise ValueError(validate_group(g))
    tmp = f"{path}.tmp-{new_id()}"
    fsync_write(tmp, json.dumps(g, ensure_ascii=False, indent=2).encode("utf-8"))
    fault("group_before_replace")
    os.replace(tmp, path)


def load_group(path):
    g = json.load(open(path, encoding="utf-8"))
    d, base = os.path.split(path)
    leftovers = [f for f in os.listdir(d or ".") if f.startswith(base + ".tmp-")]
    return g, {"problems": validate_group(g), "leftover_tmp": leftovers}


def group_libraries(g):
    return {m["source"]["library_id"] for m in g["members"]}


# ====================== 设备登记 ======================

class Device:
    """本设备登记的库与组位置。丢了可以重建，不拥有任何整理数据。"""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.file = os.path.join(root, "device.json")
        self.reg = json.load(open(self.file, encoding="utf-8")) if os.path.exists(self.file) else {"libraries": {}, "groups": []}
        self._open = {}

    def save(self):
        fsync_write(self.file, json.dumps(self.reg, ensure_ascii=False, indent=2).encode("utf-8"))

    def register_library(self, lib):
        self.reg["libraries"][lib.id] = os.path.abspath(lib.path)
        self._open[lib.id] = lib
        self.save()

    def register_group(self, path):
        p = os.path.abspath(path)
        if p not in self.reg["groups"]:
            self.reg["groups"].append(p)
        self.save()

    def library(self, lid):
        if lid in self._open:
            return self._open[lid]
        p = self.reg["libraries"].get(lid)
        if p and os.path.exists(os.path.join(p, "library.sqlite")):
            self._open[lid] = Library(p)
            return self._open[lid]
        return None

    def groups(self):
        return [(p, load_group(p)[0]) for p in self.reg["groups"]]

    def close(self):
        for lib in self._open.values():
            lib.close()
        self._open = {}

    def resolve_member(self, m):
        """成员原图在哪：ok／filled（另一库同字节原图临时补足）／content_mismatch／missing。不改写引用。"""
        src, sha = m["source"], m["expected_sha256"]
        lib = self.library(src["library_id"])
        status = "missing"
        if lib:
            rel = lib.one("SELECT rel_path FROM image WHERE id=?", src["image_id"])
            if rel and os.path.exists(lib.file(rel)):
                p = lib.file(rel)
                if sha256_file(p) == sha:
                    return {"status": "ok", "path": p}
                status = "content_mismatch"
        for lid in self.reg["libraries"]:
            other = self.library(lid)
            if not other or lid == src["library_id"]:
                continue
            rel = other.one("SELECT rel_path FROM image WHERE sha256=?", sha)
            if rel and sha256_file(other.file(rel)) == sha:
                return {"status": "filled", "path": other.file(rel), "from_library": lid, "because": status}
        return {"status": status, "path": None}


# ====================== 备份范围（Q43） ======================

def compute_scope(device, selected=None, extend=True):
    """默认全部；按库缩小时一次算清关联组、完整外库与继续延伸的依赖。"""
    groups = {g["group_id"]: (p, g["name"], group_libraries(g)) for p, g in device.groups()}
    all_libs = set(device.reg["libraries"])
    if selected is None:
        return {"libraries": sorted(all_libs), "groups": sorted(groups), "steps": ["默认：本设备全部已登记的库与组"], "uncovered": []}
    libs, gs, steps, uncovered = set(selected), set(), [], []
    frontier = list(selected)
    while frontier:
        lid = frontier.pop(0)
        for gid, (_, name, gl) in sorted(groups.items(), key=lambda kv: kv[1][1]):
            if lid in gl and gid not in gs:
                gs.add(gid)
                steps.append(("关联组", lid, name))
                for other in sorted(gl - libs):
                    if extend:
                        libs.add(other)
                        frontier.append(other)
                        steps.append(("补选完整外库", name, other))
                    else:
                        uncovered.append((name, other))
    return {"libraries": sorted(libs), "groups": sorted(gs), "steps": steps, "uncovered": sorted(set(uncovered))}


def scope_size(device, scope):
    total = 0
    for lid in scope["libraries"]:
        lib = device.library(lid)
        total += sum(r[0] for r in lib.q("SELECT size FROM image")) + os.path.getsize(os.path.join(lib.fpath, "library.sqlite"))
    paths = {g["group_id"]: p for p, g in device.groups()}
    total += sum(os.path.getsize(paths[g]) for g in scope["groups"])
    return total


# ====================== 备份与恢复 ======================

def backup(device, dest_root, scope):
    """快照 DB → 按快照复制所引用的原文件并核验 → 复制组 → 写清单 → 改名为完成。"""
    bid = time.strftime("%Y%m%d-%H%M%S-") + new_id()[:6]
    work = lp(os.path.join(dest_root, bid + ".incomplete"))
    os.makedirs(work)
    manifest = {"format": BACKUP_FORMAT, "version": 1, "backup_id": bid, "created_at": now(),
                "scope": scope, "libraries": {}, "groups": {}, "problems": []}
    for lid in scope["libraries"]:
        lib = device.library(lid)
        ldir = os.path.join(work, "libraries", lid)
        os.makedirs(ldir)
        snap = sqlite3.connect(os.path.join(ldir, "library.sqlite"))
        lib.db.backup(snap)  # SQLite Backup API：一致快照
        rows = snap.execute("SELECT rel_path, sha256 FROM image").fetchall()
        snap.close()
        files = {"library.sqlite": {"sha256": sha256_file(os.path.join(ldir, "library.sqlite"))}}
        for rel, sha in rows:
            dst = os.path.join(ldir, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(lib.file(rel), dst)
            got = sha256_file(dst)
            if got != sha:
                manifest["problems"].append(("content_mismatch", lid, rel))
            files[rel] = {"sha256": got}
            fault("backup_mid_copy")
        manifest["libraries"][lid] = {"name": lib.name, "files": files}
    paths = {g["group_id"]: p for p, g in device.groups()}
    os.makedirs(os.path.join(work, "groups"))
    for gid in scope["groups"]:
        dst = os.path.join(work, "groups", gid + ".json")
        shutil.copyfile(paths[gid], dst)
        manifest["groups"][gid] = {"sha256": sha256_file(dst), "original_name": os.path.basename(paths[gid])}
    fsync_write(os.path.join(work, "manifest.json"), json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    if manifest["problems"]:
        return work, manifest  # 留在 .incomplete，不宣称完整
    final = lp(os.path.join(dest_root, bid))
    os.replace(work, final)
    return final, manifest


def verify_backup(bdir):
    bdir = lp(bdir)
    if bdir.endswith(".incomplete") or not os.path.exists(os.path.join(bdir, "manifest.json")):
        return ["incomplete"]
    m = json.load(open(os.path.join(bdir, "manifest.json"), encoding="utf-8"))
    bad = []
    for lid, info in m["libraries"].items():
        for rel, f in info["files"].items():
            p = os.path.join(bdir, "libraries", lid, *rel.split("/"))
            if not os.path.exists(p) or sha256_file(p) != f["sha256"]:
                bad.append(("bad_file", lid, rel))
    for gid, f in m["groups"].items():
        p = os.path.join(bdir, "groups", gid + ".json")
        if not os.path.exists(p) or sha256_file(p) != f["sha256"]:
            bad.append(("bad_group", gid))
    return bad + [tuple(p) for p in m["problems"]]


def restore(bdir, device):
    """恢复为独立的库与组：新库／组身份，库内图片 ID 保留，组改连恢复出的库。输出映射。"""
    bdir = lp(bdir)
    bad = verify_backup(bdir)
    if bad:
        raise RuntimeError(f"备份不完整或已损坏：{bad[:3]}")
    m = json.load(open(os.path.join(bdir, "manifest.json"), encoding="utf-8"))
    mapping = {"backup_id": m["backup_id"], "libraries": {}, "groups": {}}
    for lid, info in m["libraries"].items():
        dst = os.path.join(device.root, "libraries", f"{info['name']}-恢复-{m['backup_id'][-6:]}")
        shutil.copytree(os.path.join(bdir, "libraries", lid), lp(dst))
        lib = Library(dst)
        nid = new_id()
        lib.db.execute("BEGIN")
        lib.db.execute("UPDATE library SET id=?", (nid,))
        lib.db.execute("INSERT INTO restore_provenance VALUES(?,?,?)", (lid, m["backup_id"], now()))
        lib.db.execute("COMMIT")
        device.register_library(lib)
        mapping["libraries"][lid] = nid
    gdir = os.path.join(device.root, "groups")
    os.makedirs(gdir, exist_ok=True)
    for gid, info in m["groups"].items():
        g = json.load(open(os.path.join(bdir, "groups", gid + ".json"), encoding="utf-8"))
        g["group_id"] = new_id()
        g["restored_from"] = {"group_id": gid, "backup_id": m["backup_id"]}
        for mem in g["members"]:
            old = mem["source"]["library_id"]
            if old in mapping["libraries"]:
                mem["source"]["library_id"] = mapping["libraries"][old]
        p = os.path.join(gdir, f"{g['name']}-恢复-{m['backup_id'][-6:]}.json")
        save_group(p, g)
        device.register_group(p)
        mapping["groups"][gid] = g["group_id"]
    return mapping


# ====================== 参考组包 ======================

def export_package(device, g, out_path):
    """组文档 + 依赖清单 + 未经重编码的原文件（同一原图只带一次）+ 所用图片的标签、备注与来源快照。"""
    files, members, snapshots = {}, {}, {}
    tmp = out_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for mem in g["members"]:
            r = device.resolve_member(mem)
            if r["status"] not in ("ok", "filled"):
                raise RuntimeError(f"成员原图不可用：{mem['member_id']} {r['status']}")
            sha = mem["expected_sha256"]
            if sha not in files:
                arc = f"originals/{sha}.{r['path'].rsplit('.', 1)[-1]}"
                z.write(r["path"], arc)
                files[sha] = {"path": arc, "size": os.path.getsize(r["path"])}
            members[mem["member_id"]] = sha
            src = mem["source"]
            key = f"{src['library_id']}/{src['image_id']}"
            lib = device.library(src["library_id"])
            if lib and key not in snapshots:
                v = lib.image_view(src["image_id"])
                snapshots[key] = {"library_name": lib.name, "tags": v["tags_effective"], "note_manual": v["note_manual"],
                                  "sources": [{"external_id": b["external_id"], "url": b["raw"].get("url"), "annotation": b["raw"].get("annotation")}
                                              for b in v["bindings"]],
                                  "region_notes": [{"text": n["text"], "x": n["x"], "y": n["y"], "w": n["w"], "h": n["h"]} for n in v["region_notes"]]}
        manifest = {"format": PACKAGE_FORMAT, "version": 1, "exported_at": now(), "group": g,
                    "files": files, "members": members, "snapshots": snapshots}
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    os.replace(tmp, out_path)
    return manifest


def open_package(pkg, dest):
    with zipfile.ZipFile(pkg) as z:
        z.extractall(dest)
    m = json.load(open(os.path.join(dest, "manifest.json"), encoding="utf-8"))
    bad = [sha for sha, f in m["files"].items() if sha256_file(os.path.join(dest, f["path"])) != sha]
    paths = {mid: os.path.join(dest, m["files"][sha]["path"]) for mid, sha in m["members"].items()}
    return m, paths, bad


def package_as_new_group(m):
    g = json.loads(json.dumps(m["group"]))
    g["group_id"] = new_id()
    g["imported_from_package"] = {"group_id": m["group"]["group_id"], "exported_at": m["exported_at"]}
    return g
