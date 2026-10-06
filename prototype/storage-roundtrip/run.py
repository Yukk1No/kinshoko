"""PROTOTYPE — #8 往返试验。python prototype/storage-roundtrip/run.py [--images <目录>]

每次运行先清空 PROTOTYPE-wipe-me/，然后依次跑场景、逐项判定门槛，写出：
  PROTOTYPE-wipe-me/report.md   门槛结果、场景记录、字段保留清单、只记录的指标
  PROTOTYPE-wipe-me/browse.html 恢复出的库与参考组，给画师浏览确认
"""
import json, os, shutil, subprocess, sys, textwrap, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eagle_sample as es
import kinshoko_store as ks

W = os.path.join(HERE, "PROTOTYPE-wipe-me")
REAL = sys.argv[sys.argv.index("--images") + 1] if "--images" in sys.argv else None

log, gates, metrics, field_rows = [], [], {}, []


def say(s=""):
    print(s)
    log.append(s)


def section(t):
    say()
    say(f"## {t}")
    say()


def gate(area, name, ok, detail=""):
    gates.append((area, name, bool(ok), detail))
    say(f"- {'✅' if ok else '❌'} **{name}**" + (f" — {detail}" if detail else ""))


def child(code, fault):
    """在子进程里跑一段代码，并在故障点直接退出，模拟断电／被杀。"""
    env = dict(os.environ, KINSHOKO_FAULT=fault, PYTHONIOENCODING="utf-8")
    pre = f"import sys; sys.path.insert(0, {HERE!r}); import kinshoko_store as ks\n"
    r = subprocess.run([sys.executable, "-c", pre + textwrap.dedent(code)], env=env, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, r.stderr.strip()


def eagle_items(lib_dir):
    out = {}
    for d in os.listdir(os.path.join(lib_dir, "images")):
        out[d[:-5]] = json.load(open(os.path.join(lib_dir, "images", d, "metadata.json"), encoding="utf-8"))
    return out


def timed(fn, *a):
    t = time.perf_counter()
    r = fn(*a)
    return r, round(time.perf_counter() - t, 3)


shutil.rmtree(ks.lp(W), ignore_errors=True)
os.makedirs(W)
SRC = os.path.join(W, "sources")
D1 = os.path.join(W, "device1")

# ---------------------------------------------------------------- 样本与首次导入
section("1. 构造样本并首次导入")
eagle_a = es.build_eagle_a(SRC)
eagle_b = es.build_eagle_b(SRC)
c_files = es.plain_files(SRC)
src_a_v1 = eagle_items(eagle_a)
src_a_root = json.load(open(os.path.join(eagle_a, "metadata.json"), encoding="utf-8"))
say(f"Eagle 样本：画师主库 {len(src_a_v1)} 项、旧库 2 项；普通文件 2 张。结构按公开 4.0 磁盘格式构造，未经真实 Eagle 写出。")

dev = ks.Device(D1)
A = ks.Library.create(os.path.join(D1, "libraries", "主库"), "主库")
B = ks.Library.create(os.path.join(D1, "libraries", "旧库"), "旧库")
C = ks.Library.create(os.path.join(D1, "libraries", "散图库"), "散图库")
for lib in (A, B, C):
    dev.register_library(lib)
ra = A.import_eagle(eagle_a)
rb = B.import_eagle(eagle_b)
rc = C.import_files(c_files)
for n, r in (("主库←画师主库", ra), ("旧库←旧库", rb), ("散图库←文件", rc)):
    say(f"- {n}：{r['status']}，成功 {r['ok']}，失败 {r['failed']}，结果 {r['outcomes']}")

eid = es.eagle_id
img = {k: A.image_by_external(eid(k)) for k in ("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8")}
img["b1"], img["b2"] = B.image_by_external(eid("b1")), B.image_by_external(eid("b2"))
img["c1"], img["c2"] = C.image_by_external("c1.png"), C.image_by_external("c2.png")

say()
say("**导入后逐字段核对（画师主库每一项）**")
field_import = {}
for iid, meta in src_a_v1.items():
    v = A.image_view(A.image_by_external(iid))
    b = next(x for x in v["bindings"] if x["external_id"] == iid)
    src_tags = {t for t in v["tags_effective"]}
    for k, val in meta.items():
        ok = b["raw"].get(k) == val
        if k == "tags":
            ok = ok and set(val) <= src_tags
        elif k == "folders":
            paths = {A.folder_path(A.one("SELECT id FROM folder WHERE source_key=?", f"{b['source']}:{f}")) for f in val}
            ok = ok and paths <= set(v["folders_effective"])
        elif k == "comments":
            mine = [n for n in v["region_notes"] if n["raw"] in val]
            ok = ok and len(mine) == len(val) and all((n["x"], n["y"], n["w"], n["h"], n["text"]) == (c["x"], c["y"], c["width"], c["height"], c["annotation"])
                                                       for n, c in zip(sorted(mine, key=lambda n: n["external_id"]), sorted(val, key=lambda c: c["id"])))
        elif k == "isDeleted":
            ok = ok and (b["state"] == "trashed") == val and (v["status"] == "trashed") == val
        elif k in ("size", "width", "height", "ext"):
            ok = ok and v[k] == val
        elif k == "name":
            ok = ok and v["original_name"] in {m["name"] for m in src_a_v1.values() if m.get("size") == v["size"]}
        field_import[k] = field_import.get(k, True) and ok
    orig = os.path.join(eagle_a, "images", iid + ".info", f"{meta['name']}.{meta['ext']}")
    field_import["(原文件 SHA-256)"] = field_import.get("(原文件 SHA-256)", True) and es.sha256_file(orig) == v["sha256"] == \
        es.sha256_file(A.file(v["rel_path"]))
raw_lib = json.loads(A.one("SELECT raw_library_json FROM import_source WHERE kind='eagle'"))
lib_fields_import = {k: raw_lib.get(k) == val for k, val in src_a_root.items()}
folder_paths = sorted(A.folder_path(r[0]) for r in A.q("SELECT id FROM folder"))
lib_fields_import["folders"] = lib_fields_import["folders"] and folder_paths == ["发型参考", "角色", "角色/女"]
gate("字段往返", "Eagle 单项字段导入后全部可取回（含未知字段 futureField）", all(field_import.values()),
     ", ".join(k for k, ok in field_import.items() if not ok) or f"{len(field_import)} 个字段")
gate("字段往返", "Eagle 库级字段导入后全部可取回（文件夹层级、智能文件夹、快速访问、标签组）", all(lib_fields_import.values()),
     f"文件夹路径 {folder_paths}")

va3 = A.image_view(img["a3"])
gate("导入规则", "同库两个 Eagle item 是同一原图 → 汇成一条图片记录，保留两份来源、标签与文件夹并集",
     img["a3"] == img["a4"] and len(va3["bindings"]) == 2 and va3["tags_effective"] == ["中分", "侧脸"]
     and {b["raw"]["annotation"] for b in va3["bindings"]} == {"来源一的备注", "来源二的备注"},
     f"标签 {va3['tags_effective']}，文件夹 {va3['folders_effective']}，备注各自保留在来源快照")
va8, vb1 = A.image_view(img["a8"]), B.image_view(img["b1"])
gate("导入规则", "两个资料库含相同原图 → 各自一条记录、各自整理，原文件字节相同",
     va8["sha256"] == vb1["sha256"] and va8["tags_effective"] != vb1["tags_effective"],
     f"主库 {va8['tags_effective']} ／ 旧库 {vb1['tags_effective']}")
va7 = A.image_view(img["a7"])
gate("导入规则", "Eagle 回收站中的图导入为本库的可恢复删除状态", va7["status"] == "trashed")
va1 = A.image_view(img["a1"])
gate("导入规则", "区域评论保留原始坐标，标注为未核验基准", len(va1["region_notes"]) == 2 and all(n["raw"].get("width") for n in va1["region_notes"]),
     "; ".join(f"{n['text']} ({n['x']},{n['y']},{n['w']}×{n['h']})" for n in va1["region_notes"]))

# ---------------------------------------------------------------- 人工整理与参考组
section("2. 人工整理与参考组")
A.decide_tag(img["a1"], "蓝发", "reject")
A.decide_tag(img["a1"], "冷色", "add")
A.set_note(img["a1"], "画师自己的备注：高光偏冷")
A.set_status(img["a3"], "trashed")
say("- 主库「蓝发少女」：否决「蓝发」、添加「冷色」、写本库备注；「同图其一／其二」进入可恢复删除。")
GD = os.path.join(D1, "groups")
os.makedirs(GD)
G = {}


def mk_group(name, members):
    g = ks.new_group(name)
    for lib, iid, crop, x, y, s in members:
        ks.add_member(g, lib, iid, crop, x, y, s)
    p = os.path.join(GD, name + ".json")
    ks.save_group(p, g)
    dev.register_group(p)
    G[name] = (p, g)
    say(f"- 参考组「{name}」：{len(g['members'])} 个成员，引用 {sorted({lib.name for lib, *_ in members}) or '无'}")
    return g


mk_group("眼睛参考", [(A, img["a1"], {"x": 10, "y": 8, "w": 12, "h": 8}, 0, 0, 4.0),
                    (A, img["a1"], {"x": 40, "y": 8, "w": 12, "h": 8}, 60, 0, 4.0),
                    (A, img["a2"], None, 0, 50, 1.5),
                    (B, img["b1"], None, 120, 0, 2.0)])
mk_group("光照", [(B, img["b2"], None, 0, 0, 1.0), (C, img["c1"], {"x": 4, "y": 4, "w": 20, "h": 20}, 60, 0, 3.0)])
mk_group("散图", [(C, img["c2"], None, 0, 0, 1.0)])
mk_group("空组", [])
g_eye = G["眼睛参考"][1]
gate("参考组", "同图两个局部是两个成员，裁切各自保存", len({m["member_id"] for m in g_eye["members"][:2]}) == 2
     and g_eye["members"][0]["crop"] != g_eye["members"][1]["crop"])

# ---------------------------------------------------------------- 重导
section("3. 在 Eagle 继续整理后重导")
es.mutate_eagle_a_v2(eagle_a)
say("Eagle 侧变化：蓝发少女加标签「光照」并改备注；紫发短发换了内容；透明立绘被彻底删除；极长条漫移入回收站；"
    "「发型参考」改名为「发型」；新增一张图。")
n_before = A.one("SELECT count(*) FROM image")
r2 = A.import_eagle(eagle_a)
say(f"- 重导：{r2['status']}，结果 {r2['outcomes']}，标记缺失 {len(r2['marked_missing'])} 项")
va1 = A.image_view(img["a1"])
b1 = next(b for b in va1["bindings"] if b["external_id"] == eid("a1"))
gate("重导", "人工否决／添加与本库备注在重导后保留，Eagle 新标签与新备注进入",
     "蓝发" not in va1["tags_effective"] and "冷色" in va1["tags_effective"] and "光照" in va1["tags_effective"]
     and va1["note_manual"] == "画师自己的备注：高光偏冷" and b1["raw"]["annotation"].endswith("（Eagle 里改过）"),
     f"有效标签 {va1['tags_effective']}")
new_a2 = A.image_by_external(eid("a2"))
va2_new, va2_old = A.image_view(new_a2), A.image_view(img["a2"])
eye_a2 = g_eye["members"][2]
gate("重导", "来源内容变化 → 新图片记录并指向旧版本；旧版本与引用它的参考组成员不受影响",
     new_a2 != img["a2"] and va2_new["previous_image_id"] == img["a2"] and va2_old["bindings"][0]["state"] == "superseded"
     and dev.resolve_member(eye_a2)["status"] == "ok")
va5, va6 = A.image_view(img["a5"]), A.image_view(img["a6"])
gate("重导", "来源彻底删除 → 标记缺失，本库副本与原文件保留",
     va5["bindings"][0]["state"] == "missing" and not A.verify())
gate("重导", "来源移入 Eagle 回收站 → 来源状态 trashed，本库状态不随之改变",
     va6["bindings"][0]["state"] == "trashed" and va6["status"] == "active")
gate("重导", "文件夹改名后归属不变、名称更新", "发型" in va1["folders_effective"], f"{va1['folders_effective']}")
gate("重导", "重导不重复创建已有记录", A.one("SELECT count(*) FROM image") == n_before + 2,
     f"{n_before} → {A.one('SELECT count(*) FROM image')}（+1 新图，+1 新版本）")

moved = eagle_a + "-搬到别处"
os.rename(eagle_a, moved)
n_before = A.one("SELECT count(*) FROM image")
dump_before = A.canonical_dump()
ask = A.import_eagle(moved)
gate("重导", "Eagle 库整体搬家后重导 → 先请用户确认是否同一来源，确认前不写任何数据（候选：外部 ID 重合 ≥ 50%）",
     ask["status"] == "needs_confirmation" and A.canonical_dump() == dump_before,
     f"候选重合比例 {ask.get('candidate', {}).get('overlap')}")
r3 = A.import_eagle(moved, source=ask["candidate"]["source_id"])
gate("重导", "用户确认是同一来源 → 沿用来源登记并更新位置，不新建记录",
     r3["relocated"] and A.one("SELECT count(*) FROM image") == n_before and set(r3["outcomes"]) == {"refreshed"},
     f"结果 {r3['outcomes']}")
moved_b = eagle_b + "-副本"
shutil.copytree(eagle_b, moved_b)
nb_before = B.one("SELECT count(*) FROM image")
ask_b = B.import_eagle(moved_b)
rb2 = B.import_eagle(moved_b, source="new")
gate("重导", "用户确认是另一个来源 → 新登记来源；相同原图汇入已有记录，不重复创建",
     ask_b["status"] == "needs_confirmation" and B.one("SELECT count(*) FROM import_source") == 2
     and B.one("SELECT count(*) FROM image") == nb_before and set(rb2["outcomes"]) == {"merged_same_original"},
     f"结果 {rb2['outcomes']}")

# ---------------------------------------------------------------- 来源失联
section("4. 来源库离线时的参考组")
eye_b = g_eye["members"][3]
grp_hash = es.sha256_file(G["眼睛参考"][0])
L = {"A": A.id, "B": B.id, "C": C.id}
b_path = B.path
dev.close()
os.rename(b_path, b_path + "-离线")
r = dev.resolve_member(eye_b)
dev.close()
os.rename(b_path + "-离线", b_path)
A, B, C = (dev.library(L[k]) for k in "ABC")
gate("参考组", "旧库离线 → 用主库中字节相同的原图临时补足显示，组文件不被改写",
     r["status"] == "filled" and r["from_library"] == A.id and es.sha256_file(G["眼睛参考"][0]) == grp_hash, f"{r['status']}，原因 {r.get('because')}")

# ---------------------------------------------------------------- 备份范围
section("5. 备份范围（Q43）")
mk_group("闭环", [(C, img["c2"], None, 0, 0, 1.0), (A, img["a8"], None, 40, 0, 1.0)])
name_of_lib = {lib.id: lib.name for lib in (A, B, C)}
name_of_group = {g["group_id"]: g["name"] for _, g in dev.groups()}


def show_scope(label, sc):
    libs = [name_of_lib[l] for l in sc["libraries"]]
    gs = sorted(name_of_group[g] for g in sc["groups"])
    say(f"**{label}** → 库 {libs}，组 {gs}，容量 {ks.scope_size(dev, sc)} 字节")
    for s in sc["steps"]:
        if isinstance(s, tuple):
            say(f"  - {s[0]}：" + ("「%s」被库 %s 引用" % (s[2], name_of_lib[s[1]]) if s[0] == "关联组" else "组「%s」还引用 %s" % (s[1], name_of_lib[s[2]])))
    for gname, lid in sc["uncovered"]:
        say(f"  - 未覆盖：组「{gname}」引用的 {name_of_lib[lid]} 不在本次备份中")
    return set(libs), set(gs), {(g, name_of_lib[l]) for g, l in sc["uncovered"]}


all_l, all_g, _ = show_scope("默认（全部）", ks.compute_scope(dev))
gate("备份范围", "默认包含全部已登记库与组，包括不引用任何库的组",
     all_l == {"主库", "旧库", "散图库"} and all_g == {"眼睛参考", "光照", "散图", "空组", "闭环"})
la, ga, ua = show_scope("只选主库，接受补选外库", ks.compute_scope(dev, [L["A"]], extend=True))
gate("备份范围", "A/B、B/C 关联链与 C/A 闭环：一次算清并终止", la == {"主库", "旧库", "散图库"} and ga == {"眼睛参考", "光照", "散图", "闭环"},
     "空组不被牵入")
la, ga, ua = show_scope("只选主库，拒绝补选外库", ks.compute_scope(dev, [L["A"]], extend=False))
gate("备份范围", "拒绝补选时列明未覆盖内容", la == {"主库"} and ga == {"眼睛参考", "闭环"} and ua == {("眼睛参考", "旧库"), ("闭环", "散图库")})
lb, gb, ub = show_scope("只选旧库，拒绝补选外库", ks.compute_scope(dev, [L["B"]], extend=False))
gate("备份范围", "从链中间开始：两侧外库都列为未覆盖", lb == {"旧库"} and gb == {"眼睛参考", "光照"} and ub == {("眼睛参考", "主库"), ("光照", "散图库")})

# ---------------------------------------------------------------- 备份与恢复
section("6. 默认备份 → 恢复为独立库与组")
pre_dump = {lid: dev.library(lid).canonical_dump() for lid in dev.reg["libraries"]}
pre_views = {lid: {i: dev.library(lid).image_view(i) for (i,) in dev.library(lid).q("SELECT id FROM image")} for lid in dev.reg["libraries"]}
pre_groups = {g["group_id"]: g for _, g in dev.groups()}
pre_group_hashes = {p: es.sha256_file(p) for p in dev.reg["groups"]}
BK = os.path.join(W, "backups")
os.makedirs(BK)
(bdir, bman), t_backup = timed(ks.backup, dev, BK, ks.compute_scope(dev))
metrics["默认备份耗时（秒）"] = t_backup
metrics["默认备份容量（字节）"] = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(bdir) for f in fs)
gate("备份恢复", "备份完成并通过自检", not ks.verify_backup(bdir), os.path.basename(bdir))
D2 = os.path.join(W, "device2-恢复后")
dev2 = ks.Device(D2)
mapping, t_restore = timed(ks.restore, bdir, dev2)
metrics["默认恢复耗时（秒）"] = t_restore
dump_ok, view_ok, sha_ok = True, True, True
for old, new in mapping["libraries"].items():
    nl = dev2.library(new)
    dump_ok &= nl.canonical_dump() == pre_dump[old]
    for i, v in pre_views[old].items():
        view_ok &= nl.image_view(i) == v
    sha_ok &= not nl.verify()
gate("字段往返", "恢复后每个库的全部表逐行一致（库身份除外）", dump_ok)
gate("字段往返", "恢复后每张图片的完整视图一致（标签、人工决定、文件夹、来源原始 JSON、区域评论、状态）", view_ok)
gate("原文件", "恢复后每个原文件 SHA-256 与记录一致", sha_ok)
grp_ok, resolve_ok = True, True
for _, g in dev2.groups():
    old = pre_groups[g["restored_from"]["group_id"]]
    remapped = json.loads(json.dumps(old))
    for m in remapped["members"]:
        m["source"]["library_id"] = mapping["libraries"][m["source"]["library_id"]]
    strip = lambda x: {k: v for k, v in x.items() if k not in ("group_id", "restored_from")}
    grp_ok &= strip(g) == strip(remapped) and g["group_id"] != old["group_id"]
    for m in g["members"]:
        r = dev2.resolve_member(m)
        resolve_ok &= r["status"] == "ok" and r["path"].startswith(dev2.library(m["source"]["library_id"]).fpath)
gate("字段往返", "恢复出的组：新组身份，裁切／位置／缩放／视口一致，成员改连恢复出的库", grp_ok)
gate("备份恢复", "恢复出的组的每个成员都能从恢复库取到原图", resolve_ok)
gate("备份恢复", "恢复不改写原设备上现有的组", all(es.sha256_file(p) == h for p, h in pre_group_hashes.items()))
trashed_ok = any(dev2.library(l).one("SELECT count(*) FROM image WHERE status='trashed'") for l in dev2.reg["libraries"])
gate("备份恢复", "可恢复删除的图片也在备份中", trashed_ok)

# ---------------------------------------------------------------- 组包
section("7. 跨库参考组打包 → 在空白位置打开")
PK = os.path.join(W, "眼睛参考.kinshoko-pack")
g_eye = ks.load_group(G["眼睛参考"][0])[0]
pman = ks.export_package(dev, g_eye, PK)
pm, ppaths, pbad = ks.open_package(PK, os.path.join(W, "空白设备"))
uniq = {m["expected_sha256"] for m in g_eye["members"]}
gate("原文件", "包内原文件 SHA-256 与成员预期一致，同一原图只带一次", not pbad and len(pm["files"]) == len(uniq),
     f"{len(g_eye['members'])} 个成员，{len(pm['files'])} 个原文件")
gate("参考组包", "脱离来源库打开：每个成员都能取到原图", all(os.path.exists(p) for p in ppaths.values()))
snap = pm["snapshots"][f"{A.id}/{img['a1']}"]
gate("参考组包", "带上所用图片的标签、备注、来源与区域评论快照；不带来源库其他素材",
     "冷色" in snap["tags"] and snap["note_manual"] and snap["sources"][0]["url"] and len(snap["region_notes"]) == 2
     and len(pm["snapshots"]) == len({(m["source"]["library_id"], m["source"]["image_id"]) for m in g_eye["members"]}))
ng = ks.package_as_new_group(pm)
gate("字段往返", "包另存为新组：新组身份，成员与布局逐字一致",
     ng["group_id"] != g_eye["group_id"] and ng["members"] == g_eye["members"] and ng["viewport"] == g_eye["viewport"])

# ---------------------------------------------------------------- 中断与部分失败
section("8. 写入中断与部分失败（Q38）")
bulk, broken = es.build_eagle_bulk(SRC, real_images=REAL)
say(f"批量库 {1000} 项，其中 12 项损坏：{sorted({k for _, k in broken})} 各 4 项。")
D3 = os.path.join(W, "device3-批量")
BL = ks.Library.create(os.path.join(D3, "批量"), "批量")
BL.close()
code, err = child(f"lib = ks.Library({BL.path!r}); lib.import_eagle({bulk!r})", "import_after_publish@500")
BL = ks.Library(BL.path)
rec = BL.recover()
n_crash = BL.one("SELECT count(*) FROM image")
say(f"- 第 500 个原文件发布后、记录提交前杀进程（退出码 {code}）：已提交 {n_crash} 条；"
    f"自检发现未完成导入 {len(rec['interrupted_runs'])} 次、未登记原文件 {len(rec['orphan_originals'])} 个")
gate("中断", "中断后打开：未完成的导入被标出，未登记原文件被报告而不删除",
     code == 99 and len(rec["interrupted_runs"]) == 1 and len(rec["orphan_originals"]) == 1)
r1 = BL.import_eagle(bulk)
say(f"- 重试：{r1['status']}，成功 {r1['ok']}，失败 {r1['failed']}，结果 {r1['outcomes']}")
reasons = sorted({f[1].split("（")[0] for f in r1["failures"]})
gate("部分失败", "部分失败：保留成功项，整体标注部分成功，逐项列出失败原因",
     r1["status"] == "partial" and r1["ok"] == 988 and r1["failed"] == 12 and BL.one("SELECT count(*) FROM image") == 988, f"原因 {reasons}")
gate("中断", "重试复用中断时已发布的原文件，不留孤立文件", r1["outcomes"].get("created_reused_file") == 1 and not BL.orphans())
r1b = BL.import_eagle(bulk)
gate("部分失败", "不修来源直接再试：不重复创建，失败项照旧报告",
     BL.one("SELECT count(*) FROM image") == 988 and r1b["failed"] == 12 and set(r1b["outcomes"]) == {"refreshed"})
es.repair_bulk(bulk)
r1c = BL.import_eagle(bulk)
dups = BL.one("SELECT count(*) FROM (SELECT sha256 FROM image GROUP BY sha256 HAVING count(*) > 1)")
gate("部分失败", "修好来源后重试：补齐 12 项，总数 1000，无重复记录",
     r1c["status"] == "ok" and BL.one("SELECT count(*) FROM image") == 1000 and dups == 0, f"结果 {r1c['outcomes']}")
BL.close()

BL2 = ks.Library.create(os.path.join(D3, "批量-事务中断"), "批量-事务中断")
BL2.close()
code, _ = child(f"lib = ks.Library({BL2.path!r}); lib.import_eagle({bulk!r})", "import_before_commit@300")
BL2 = ks.Library(BL2.path)
rec2 = BL2.recover()
n2 = BL2.one("SELECT count(*) FROM image")
r2b = BL2.import_eagle(bulk)
gate("中断", "事务提交前被杀：该项整体回滚，重试后补齐且不重复",
     code == 99 and n2 == 299 and r2b["status"] == "ok" and BL2.one("SELECT count(*) FROM image") == 1000 and not BL2.orphans(),
     f"中断时 {n2} 条，未登记原文件 {len(rec2['orphan_originals'])} 个，重试后 {BL2.one('SELECT count(*) FROM image')} 条")
BL2.close()

TL = ks.Library.create(os.path.join(D3, "计时"), "计时")
r_t, t_imp = timed(TL.import_eagle, bulk)
metrics["1000 项 Eagle 导入耗时（秒，干净库）"] = t_imp
TL.close()

gp = G["眼睛参考"][0]
before = open(gp, "rb").read()
dev.close()
code, _ = child(f"""
    import json
    g, _ = ks.load_group({gp!r})
    for m in g["members"]:
        m["scale"] *= 2
    ks.save_group({gp!r}, g)
""", "group_before_replace@1")
g_after, info = ks.load_group(gp)
gate("中断", "保存参考组时被杀：旧版本完整可读，临时文件被识别",
     code == 99 and open(gp, "rb").read() == before and not info["problems"] and len(info["leftover_tmp"]) == 1)
for t in info["leftover_tmp"]:
    os.remove(os.path.join(GD, t))

code, _ = child(f"""
    dev = ks.Device({D1!r})
    ks.backup(dev, {BK!r}, ks.compute_scope(dev))
""", "backup_mid_copy@5")
inc = [d for d in os.listdir(BK) if d.endswith(".incomplete")]
refused = False
try:
    ks.restore(os.path.join(BK, inc[0]), ks.Device(os.path.join(W, "device4")))
except RuntimeError:
    refused = True
dev = ks.Device(D1)
bdir2, _ = ks.backup(dev, BK, ks.compute_scope(dev))
gate("中断", "备份复制中被杀：留下的半成品不会被当成完整备份，恢复拒绝；重跑得到完整备份",
     code == 99 and len(inc) == 1 and ks.verify_backup(os.path.join(BK, inc[0])) == ["incomplete"] and refused and not ks.verify_backup(bdir2))

# ---------------------------------------------------------------- 内容被替换
section("9. 库内原文件被外部替换")
C = dev.library(L["C"])
cp = C.file(C.one("SELECT rel_path FROM image WHERE id=?", img["c1"]))
data = bytearray(open(cp, "rb").read())
data[-20] ^= 0xFF
open(cp, "wb").write(bytes(data))
light = ks.load_group(G["光照"][0])[0]
r = dev.resolve_member(light["members"][1])
bdir3, bman3 = ks.backup(dev, BK, ks.compute_scope(dev))
gate("原文件", "原文件字节被改：自检报告，成员不静默显示新内容，备份不标记为完整",
     C.verify() == [("content_mismatch", img["c1"])] and r["status"] == "content_mismatch" and bdir3.endswith(".incomplete"),
     f"成员状态 {r['status']}，备份问题 {bman3['problems']}")
dev.close()
dev2.close()

# ---------------------------------------------------------------- 字段保留清单
item_keys = sorted({k for m in src_a_v1.values() for k in m})
pkg_keys = {"tags": "有效标签", "url": "来源 URL", "annotation": "整图备注", "comments": "区域评论文字与矩形"}
interp = {"tags": "assertion(tag)", "folders": "assertion(folder) → folder", "comments": "region_note", "isDeleted": "source_binding.state + image.status",
          "size": "image.size", "width": "image.width", "height": "image.height", "ext": "image.ext", "name": "image.original_name", "(原文件 SHA-256)": "image.sha256 + originals/ 文件名"}
for k in item_keys + ["(原文件 SHA-256)"]:
    field_rows.append((f"item.{k}" if not k.startswith("(") else k, interp.get(k, "仅原始 JSON"), field_import.get(k, False), view_ok, pkg_keys.get(k, "—")))
for k in sorted(src_a_root):
    field_rows.append((f"library.{k}", "folder 表 + 原始 JSON" if k == "folders" else "仅原始 JSON", lib_fields_import[k], dump_ok, "—"))
for k, where in [("人工标签决定（添加／否决）", "manual_decision"), ("本库备注", "image.note_manual"), ("可恢复删除状态", "image.status"),
                 ("新旧版本关系", "image.previous_image_id"), ("来源绑定与状态", "source_binding"), ("导入记录与失败原因", "import_run / import_failure")]:
    field_rows.append((k, where, True, dump_ok, "有效标签与备注" if k in ("人工标签决定（添加／否决）", "本库备注") else "—"))
for k in ["group.name", "group.viewport", "member.member_id", "member.source", "member.expected_sha256", "member.source_size", "member.crop", "member.x / y / scale"]:
    field_rows.append((k, "组 JSON", "—", grp_ok, "逐字一致"))

# ---------------------------------------------------------------- 报告
passed = sum(g[2] for g in gates)
out = [f"# #8 往返试验结果", "", f"生成于 {ks.now()}；{passed}/{len(gates)} 项通过。样本为脚本构造，结构依据公开 Eagle 4.0 磁盘格式，未经真实 Eagle 写出。", "",
       "## 门槛", "", "| 方面 | 检查 | 结果 |", "|---|---|---|"]
out += [f"| {a} | {n}{('（' + d + '）') if d else ''} | {'✅' if ok else '❌'} |" for a, n, ok, d in gates]
out += ["", "## 字段保留清单", "", "Eagle 字段一律保存原始 JSON；下表“解释为”列是额外解析成可查询数据的位置。",
        "", "| 字段 | 解释为 | 导入后取回 | 备份恢复后一致 | 参考组包快照 |", "|---|---|---|---|---|"]
mark = lambda x: "✅" if x is True else ("❌" if x is False else x)
out += [f"| {a} | {b} | {mark(c)} | {mark(d)} | {e} |" for a, b, c, d, e in field_rows]
out += ["", "## 只记录", ""] + [f"- {k}：{v}" for k, v in metrics.items()]
out += ["", "## 场景记录", ""] + log
open(os.path.join(W, "report.md"), "w", encoding="utf-8").write("\n".join(out) + "\n")

# 画师浏览页：恢复出的库与组（图片内嵌，单文件可直接发给画师）
import base64


def data_uri(path):
    return "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode()


dev2 = ks.Device(D2)
h = ["<!doctype html><meta charset=utf-8><title>恢复后浏览</title><style>body{font:14px system-ui;margin:24px;max-width:960px}"
     "img,.crop{image-rendering:pixelated;border:1px solid #ccc;margin:4px}.row{display:flex;flex-wrap:wrap;align-items:flex-end}"
     "figure{margin:6px;font-size:12px}.tr{opacity:.45}</style><h1>恢复后浏览</h1>"
     "<p>以下内容全部来自恢复出的独立库与组。请确认素材与参考组都在、局部范围正确。半透明的是可恢复删除的图片。</p>"]
for lid, path in dev2.reg["libraries"].items():
    lib = dev2.library(lid)
    h.append(f"<h2>{lib.name}</h2><div class=row>")
    for (iid,) in lib.q("SELECT id FROM image ORDER BY created_at"):
        v = lib.image_view(iid)
        rel = data_uri(lib.file(v["rel_path"]))
        h.append(f"<figure class={'tr' if v['status'] == 'trashed' else ''}><img src='{rel}' height=96><figcaption>{v['original_name']}<br>{'、'.join(v['tags_effective'])}</figcaption></figure>")
    h.append("</div>")
for _, g in dev2.groups():
    h.append(f"<h2>参考组：{g['name']}</h2><div class=row>")
    for m in g["members"]:
        r = dev2.resolve_member(m)
        rel = data_uri(r["path"])
        c, s = m["crop"], m["scale"] * 2
        if c == "whole":
            h.append(f"<figure><img src='{rel}' style='width:{(m['source_size']['w'] or 32) * s}px'><figcaption>整图 ×{m['scale']}</figcaption></figure>")
        else:
            w, hh = m["source_size"]["w"], m["source_size"]["h"]
            h.append(f"<figure><div class=crop style=\"width:{c['w'] * s}px;height:{c['h'] * s}px;background:url('{rel}') -{c['x'] * s}px -{c['y'] * s}px/{w * s}px {hh * s}px\"></div>"
                     f"<figcaption>局部 {c['x']},{c['y']} {c['w']}×{c['h']} ×{m['scale']}</figcaption></figure>")
    h.append("</div>")
open(os.path.join(D2, "browse.html"), "w", encoding="utf-8").write("".join(h))
dev2.close()

say()
say(f"共 {passed}/{len(gates)} 项通过。报告：{os.path.join(W, 'report.md')}；浏览页：{os.path.join(D2, 'browse.html')}")
sys.exit(0 if passed == len(gates) else 1)
