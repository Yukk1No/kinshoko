"""PROTOTYPE — 按公开 4.0 磁盘结构构造 Eagle 样本库。

结构依据 docs/research/eagle-storage-practices.md：
  <name>.library/metadata.json, mtime.json, images/<id>.info/{metadata.json, <name>.<ext>, <name>_thumbnail.png}
这不是 Eagle 真正写出的库；正式样本仍需在画师电脑的 Eagle 中构造后复核。
"""
import hashlib, json, os, random, struct, zlib

ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def png(w, h, seed, alpha=False):
    """生成确定性的小 PNG，seed 不同则字节不同。"""
    rnd = random.Random(seed)
    base = [rnd.randrange(256) for _ in range(3)]
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            px = [(base[i] + x * (i + 1) + y * (3 - i)) % 256 for i in range(3)]
            if alpha:
                px.append(0 if (x + y) % 7 == 0 else 200)
            rows.extend(px)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6 if alpha else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def eagle_id(seed):
    rnd = random.Random(f"id-{seed}")
    return "".join(rnd.choice(ALNUM) for _ in range(13))


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def item_meta(iid, name, data, w, h, *, tags=(), folders=(), url="", annotation="", deleted=False, comments=(), t=1756571097667):
    return {
        "id": iid, "name": name, "size": len(data), "btime": t, "mtime": t, "ext": "png",
        "tags": list(tags), "folders": list(folders), "isDeleted": deleted, "url": url,
        "annotation": annotation, "modificationTime": t + 1000, "height": h, "width": w,
        "lastModified": t + 2000,
        "palettes": [{"color": [12, 34, 56], "ratio": 61, "$$hashKey": "object:1"}],
        "order": {f: str(t + i) + ".5" for i, f in enumerate(folders)},
        "comments": list(comments),
        "star": 3,
        "futureField": {"note": "未知字段，导入须原样保留"},
    }


def put_item(lib, meta, data):
    d = os.path.join(lib, "images", meta["id"] + ".info")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{meta['name']}.{meta['ext']}"), "wb") as f:
        f.write(data)
    with open(os.path.join(d, f"{meta['name']}_thumbnail.png"), "wb") as f:
        f.write(png(4, 4, "thumb-" + meta["id"]))
    write_json(os.path.join(d, "metadata.json"), meta)


def finish_library(lib, folders, items, *, smart=(), quick=(), tag_groups=()):
    write_json(os.path.join(lib, "metadata.json"), {
        "folders": folders, "smartFolders": list(smart), "quickAccess": list(quick),
        "tagsGroups": list(tag_groups), "modificationTime": 1760228119055,
        "applicationVersion": "4.0.0",
    })
    mt = {m["id"]: m["modificationTime"] for m in items}
    mt["all"] = len(items)
    write_json(os.path.join(lib, "mtime.json"), mt)


def folder(fid, name, children=(), cover=None):
    return {"id": fid, "name": name, "description": "", "children": list(children), "modificationTime": 1759876940271,
            "tags": [], "iconColor": "blue", "password": "", "passwordTips": "", "coverId": cover}


# 共享原图：A 库与 B 库都有这张；A 内另有两个 Eagle item 同字节
SHARED_AB = ("shared-ab", 48, 40)
DUP_IN_A = ("dup-in-a", 40, 40)


def build_eagle_a(root):
    """画师主库：一图多文件夹、标签、URL、备注、区域评论、回收站、透明图、极长图、同字节双 item。"""
    lib = os.path.join(root, "画师主库.library")
    F_ROLE, F_GIRL, F_HAIR = eagle_id("fa1"), eagle_id("fa2"), eagle_id("fa3")
    items = []

    def add(key, name, w, h, seed=None, alpha=False, **kw):
        data = png(w, h, seed or key, alpha)
        m = item_meta(eagle_id(key), name, data, w, h, **kw)
        put_item(lib, m, data)
        items.append(m)
        return m

    add("a1", "蓝发少女", 64, 48, tags=["蓝发", "长发", "齐刘海"], folders=[F_GIRL, F_HAIR],
        url="https://www.pixiv.net/artworks/100000001", annotation="看眼睛高光",
        comments=[
            {"id": "C1", "x": 10, "y": 8, "width": 12, "height": 8, "annotation": "左眼", "lastModified": 1760000000001},
            {"id": "C2", "x": 40, "y": 8, "width": 12, "height": 8, "annotation": "右眼", "lastModified": 1760000000002},
        ])
    add("a2", "紫发短发", 40, 56, tags=["紫发", "短发"], folders=[F_GIRL], url="https://www.pixiv.net/artworks/100000002")
    add("a3", "同图其一", DUP_IN_A[1], DUP_IN_A[2], seed=DUP_IN_A[0], tags=["中分"], folders=[F_HAIR],
        url="https://example.com/one", annotation="来源一的备注")
    add("a4", "同图其二", DUP_IN_A[1], DUP_IN_A[2], seed=DUP_IN_A[0], tags=["中分", "侧脸"], folders=[F_GIRL],
        url="https://example.com/two", annotation="来源二的备注")
    add("a5", "透明立绘", 32, 48, alpha=True, tags=["透明"], folders=[F_GIRL])
    add("a6", "极长条漫", 16, 200, tags=["极长图"], folders=[F_ROLE])
    add("a7", "回收站里的图", 24, 24, tags=["废稿"], deleted=True)
    add("a8", "两库共有", SHARED_AB[1], SHARED_AB[2], seed=SHARED_AB[0], tags=["双马尾"], folders=[F_HAIR],
        url="https://www.pixiv.net/artworks/100000008")
    folders = [folder(F_ROLE, "角色", [folder(F_GIRL, "女", cover=items[0]["id"])]), folder(F_HAIR, "发型参考")]
    finish_library(lib, folders, items,
                   smart=[{"id": "S1", "name": "近期蓝发", "conditions": [{"rules": [{"property": "tags", "method": "union", "value": ["蓝发"]}]}]}],
                   quick=[{"type": "folder", "id": F_HAIR}],
                   tag_groups=[{"id": "TG1", "name": "发色", "tags": ["蓝发", "紫发"], "color": "blue"}])
    return lib


def build_eagle_b(root):
    lib = os.path.join(root, "旧库.library")
    F = eagle_id("fb1")
    items = []
    for key, name, w, h, seed, tags in [
        ("b1", "两库共有", SHARED_AB[1], SHARED_AB[2], SHARED_AB[0], ["双马尾", "旧标签"]),
        ("b2", "侧光", 50, 30, None, ["复杂光照"]),
    ]:
        data = png(w, h, seed or key)
        m = item_meta(eagle_id(key), name, data, w, h, tags=tags, folders=[F], url="https://example.com/b")
        put_item(lib, m, data)
        items.append(m)
    finish_library(lib, [folder(F, "角色")], items)
    return lib


def mutate_eagle_a_v2(lib):
    """模拟画师在 Eagle 里继续整理后再导出：加标签、改备注、换内容、彻底删除、移入回收站、改文件夹名、新增。"""
    def load(key):
        p = os.path.join(lib, "images", eagle_id(key) + ".info", "metadata.json")
        return p, json.load(open(p, encoding="utf-8"))

    p, m = load("a1")
    m["tags"].append("光照")
    m["annotation"] = "看眼睛高光（Eagle 里改过）"
    write_json(p, m)

    p, m = load("a2")  # 同 item 换了内容
    d = os.path.dirname(p)
    data = png(40, 56, "a2-v2")
    with open(os.path.join(d, f"{m['name']}.png"), "wb") as f:
        f.write(data)
    m["size"] = len(data)
    write_json(p, m)

    p, m = load("a6")  # 移入 Eagle 回收站
    m["isDeleted"] = True
    write_json(p, m)

    import shutil
    shutil.rmtree(os.path.join(lib, "images", eagle_id("a5") + ".info"))  # 彻底删除

    data = png(30, 30, "a9")
    m9 = item_meta(eagle_id("a9"), "新收的图", data, 30, 30, tags=["新"], folders=[eagle_id("fa3")])
    put_item(lib, m9, data)

    root = json.load(open(os.path.join(lib, "metadata.json"), encoding="utf-8"))
    for f in root["folders"]:
        if f["id"] == eagle_id("fa3"):
            f["name"] = "发型"
    write_json(os.path.join(lib, "metadata.json"), root)
    mt = json.load(open(os.path.join(lib, "mtime.json"), encoding="utf-8"))
    mt.pop(eagle_id("a5"), None)
    mt[eagle_id("a9")] = m9["modificationTime"]
    mt["all"] = len(mt) - 1
    write_json(os.path.join(lib, "mtime.json"), mt)


def build_eagle_bulk(root, n=1000, broken=12, real_images=None):
    """批量库：n 项，其中 broken 项损坏（缺原图只剩缩略图／坏 JSON／大小不符各三分之一）。"""
    lib = os.path.join(root, "批量.library")
    real = sorted(os.path.join(real_images, f) for f in os.listdir(real_images)) if real_images else []
    items, bad = [], []
    for i in range(n):
        key = f"bulk{i}"
        if real:
            data = open(real[i % len(real)], "rb").read() + i.to_bytes(4, "big")  # 追加字节保证互不相同
            w = h = 0
        else:
            w, h = 8 + i % 23, 8 + i % 17
            data = png(w, h, key)
        m = item_meta(eagle_id(key), f"bulk_{i:04d}", data, w, h, tags=[f"批次{i % 10}"])
        put_item(lib, m, data)
        items.append(m)
    step = n // broken
    for k in range(broken):
        m = items[k * step + 1]
        d = os.path.join(lib, "images", m["id"] + ".info")
        kind = ("missing_original", "bad_json", "size_mismatch")[k % 3]
        if kind == "missing_original":
            os.rename(os.path.join(d, f"{m['name']}.png"), os.path.join(d, f"{m['name']}.png.hidden"))
        elif kind == "bad_json":
            os.rename(os.path.join(d, "metadata.json"), os.path.join(d, "metadata.json.good"))
            with open(os.path.join(d, "metadata.json"), "w", encoding="utf-8") as f:
                f.write('{"id": "' + m["id"] + '", "name": ')
        else:
            bad_meta = dict(m, size=m["size"] + 1)
            write_json(os.path.join(d, "metadata.json.bad"), bad_meta)
            os.rename(os.path.join(d, "metadata.json"), os.path.join(d, "metadata.json.good"))
            os.rename(os.path.join(d, "metadata.json.bad"), os.path.join(d, "metadata.json"))
        bad.append((m["id"], kind))
    finish_library(lib, [], items)
    return lib, bad


def repair_bulk(lib):
    """修复批量库中的损坏项（模拟用户把源修好后重试）。"""
    for d, _, files in os.walk(os.path.join(lib, "images")):
        for f in files:
            if f.endswith(".png.hidden"):
                os.rename(os.path.join(d, f), os.path.join(d, f[:-7]))
            if f == "metadata.json.good":
                os.replace(os.path.join(d, f), os.path.join(d, "metadata.json"))


def plain_files(root):
    """C 库用的普通文件导入。"""
    d = os.path.join(root, "散图")
    os.makedirs(d, exist_ok=True)
    out = []
    for key, w, h in [("c1", 36, 36), ("c2", 60, 20)]:
        p = os.path.join(d, key + ".png")
        with open(p, "wb") as f:
            f.write(png(w, h, key))
        out.append(p)
    return out


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
