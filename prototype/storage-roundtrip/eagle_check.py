"""PROTOTYPE — #8 真实 Eagle 往返检查，给画师电脑用。

双击运行（打包后的 exe），全程自动：
  1. 找到本机的 Eagle 资料库（Eagle 本地 API → %APPDATA%\\Eagle 设置 → 扫描磁盘）。
  2. 从最大的库里挑几百张图，复制到工作区。只读原库，从不写入。
  3. 在副本上跑 run.py 的同一套门槛：字段往返、原文件 SHA-256、重导、搬家、备份范围、备份恢复、组包、中断与部分失败。
     “画师在 Eagle 里继续整理”由程序直接改副本模拟；缺的样本形态（同库重复、两库共有）也在副本上合成，并在报告中注明。
  4. 打开恢复后的浏览页，在控制台问几个问题，最后把报告打成 zip。

报告只含字段名、计数、耗时、容量和硬件型号，不含文件名、标签、备注、路径和图片（验收约定“反馈渠道”）。
浏览页 browse.html 引用工作区里的图片，只留在画师电脑上。

开发时：python eagle_check.py --library <某个.library> --yes --no-questions
"""
import argparse, ctypes, json, os, platform, random, re, shutil, string, subprocess, sys, time, traceback, urllib.request, webbrowser, zipfile

FROZEN = getattr(sys, "frozen", False)
EXE_DIR = os.path.dirname(sys.executable if FROZEN else os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kinshoko_store as ks  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

TOOL_VERSION = "2026-10-06"
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif"}
MAX_FILE = 40 * 1024 * 1024
EAGLE_API = "http://localhost:41595/api/library/history"
SKIP_DIRS = {"windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "appdata",
             "system volume information", "node_modules", ".git", "msocache", "recovery", "perflogs"}

log, gates, metrics, field_rows, synthesized, notes = [], [], {}, [], [], []
SCRUB = []  # (原文, 替换) —— 报告写出前统一替换


def say(s=""):
    print(s, flush=True)
    log.append(s)


def section(t):
    say()
    say(f"## {t}")
    say()


def gate(area, name, ok, detail=""):
    gates.append((area, name, bool(ok), detail))
    say(f"- {'✅' if ok else '❌'} **{name}**" + (f" — {detail}" if detail else ""))


def skip(area, name, why):
    gates.append((area, name, None, why))
    say(f"- ⏭ **{name}** — 未覆盖：{why}")


def scrub(text):
    for raw, rep in SCRUB:
        if raw:
            text = text.replace(raw, rep).replace(raw.replace("\\", "/"), rep).replace(raw.replace("\\", "\\\\"), rep)
    return text


def timed(fn, *a, **kw):
    t = time.perf_counter()
    r = fn(*a, **kw)
    return r, round(time.perf_counter() - t, 3)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def eagle_like_id(rnd):
    return "KSYN" + "".join(rnd.choice(string.ascii_uppercase + string.digits) for _ in range(9))


def workspace(explicit):
    """恢复库里最深的路径约是 工作区 + 125 个字符。浏览器按普通路径打开图片，超过 260 就显示不出来，
    所以 exe 放得太深时改用 LOCALAPPDATA 下的 kinshoko-check。"""
    if explicit:
        return os.path.abspath(explicit)
    w = os.path.join(EXE_DIR, "kinshoko-check-工作区")
    if len(w) > 120 and os.environ.get("LOCALAPPDATA"):
        w = os.path.join(os.environ["LOCALAPPDATA"], "kinshoko-check")
    return os.path.abspath(w)


# ====================== 子进程：故障注入 ======================

def child_main(op, payload):
    p = json.loads(payload)
    if op == "import":
        ks.Library(p["lib"]).import_eagle(p["src"], allow_any_version=True)
    elif op == "save_group":
        g, _ = ks.load_group(p["path"])
        for m in g["members"]:
            m["scale"] *= 2
        ks.save_group(p["path"], g)
    elif op == "backup":
        dev = ks.Device(p["dev"])
        ks.backup(dev, p["dest"], ks.compute_scope(dev))
    sys.exit(0)


def child(op, payload, fault):
    """在子进程里执行一步，并在故障点直接退出，模拟断电／被杀。"""
    env = dict(os.environ, KINSHOKO_FAULT=fault, PYTHONIOENCODING="utf-8")
    cmd = [sys.executable] + ([] if FROZEN else [os.path.abspath(__file__)]) + ["--child", op, json.dumps(payload, ensure_ascii=False)]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stderr.strip()[-400:]


# ====================== 找 Eagle 资料库 ======================

def is_eagle_library(p):
    return os.path.isfile(os.path.join(p, "metadata.json")) and os.path.isdir(os.path.join(p, "images"))


def from_api():
    try:
        with urllib.request.urlopen(EAGLE_API, timeout=2) as r:
            d = json.load(r)
        return [x for x in d.get("data", []) if isinstance(x, str)], True
    except Exception:
        return [], False


LIB_RE = re.compile(r'([A-Za-z]:(?:\\\\|\\|/)[^"\r\n<>|*?:]*?\.library)(?=["\\/\r\n,\]]|$)')


def from_settings():
    root = os.path.join(os.environ.get("APPDATA", ""), "Eagle")
    found = []
    if not os.path.isdir(root):
        return found
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x.lower() not in {"cache", "code cache", "gpucache", "blob_storage", "logs", "crashpad"}]
        for f in files:
            p = os.path.join(d, f)
            try:
                if os.path.getsize(p) > 5 * 1024 * 1024:
                    continue
                text = open(p, "rb").read().decode("utf-8", "ignore")
            except OSError:
                continue
            try:
                found += [x for x in json_strings(json.loads(text)) if x.lower().rstrip("\\/").endswith(".library")]
            except ValueError:
                pass
            for m in LIB_RE.findall(text):
                found.append(m.replace("\\\\", "\\"))
    return found


def json_strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from json_strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from json_strings(v)


def fixed_drives():
    if os.name != "nt":
        return ["/"]
    out = []
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    for i in range(26):
        if mask & (1 << i):
            root = f"{chr(65 + i)}:\\"
            if ctypes.windll.kernel32.GetDriveTypeW(root) == 3:  # DRIVE_FIXED
                out.append(root)
    return out


def from_scan(limit_s=40):
    t0, found = time.time(), []
    home = os.path.expanduser("~")
    starts = [(os.path.join(home, d), 4) for d in os.listdir(home) if not d.startswith(".")] if os.path.isdir(home) else []
    starts += [(r, 3) for r in fixed_drives()]
    seen = set()
    for start, depth in starts:
        stack = [(start, 0)]
        while stack and time.time() - t0 < limit_s:
            p, lvl = stack.pop()
            key = os.path.normcase(p)
            if key in seen:
                continue
            seen.add(key)
            if p.lower().endswith(".library") and is_eagle_library(p):
                found.append(p)
                continue
            if lvl >= depth:
                continue
            try:
                with os.scandir(p) as it:
                    for e in it:
                        if e.is_dir(follow_symlinks=False) and e.name.lower() not in SKIP_DIRS:
                            stack.append((e.path, lvl + 1))
            except OSError:
                pass
    return found


def library_summary(p):
    # 按 images/ 下的条目目录计数。画师电脑上 mtime.json 的 "all" 是 3，而库里实际有 2126 项，不能用来比大小。
    n = len([d for d in os.listdir(os.path.join(p, "images")) if d.endswith(".info")])
    try:
        ver = read_json(os.path.join(p, "metadata.json")).get("applicationVersion")
    except (OSError, ValueError):
        ver = None
    return {"path": p, "items": n, "version": ver}


def discover(explicit):
    if explicit:
        libs = [os.path.abspath(p) for p in explicit]
        return [library_summary(p) for p in libs if is_eagle_library(p)], {"explicit": len(libs)}
    api, running = from_api()
    settings = from_settings()
    cands = api + settings
    how = {"eagle_running": running, "api": len(api), "settings": len(settings), "scan": 0}
    if not [p for p in cands if is_eagle_library(p)]:
        print("没在 Eagle 设置里找到资料库，正在扫描磁盘（最多约 40 秒）……", flush=True)
        scan = from_scan()
        how["scan"] = len(scan)
        cands += scan
    uniq = {}
    for p in cands:
        if is_eagle_library(p):
            uniq.setdefault(os.path.normcase(os.path.abspath(p)), os.path.abspath(p))
    libs = sorted((library_summary(p) for p in uniq.values()), key=lambda x: -x["items"])
    return libs, how


# ====================== 挑样本并复制 ======================

def scan_items(lib, cap, rnd):
    """读条目 metadata.json。很大的库只随机读 cap 个，用于挑样本与统计。"""
    img_dir = os.path.join(lib, "images")
    dirs = [d for d in os.listdir(img_dir) if d.endswith(".info")]
    total = len(dirs)
    if len(dirs) > cap:
        dirs = rnd.sample(dirs, cap)
    items, unreadable = [], 0
    for i, d in enumerate(dirs):
        if i and i % 2000 == 0:
            print(f"  已读 {i}/{len(dirs)} 条元数据……", flush=True)
        try:
            m = read_json(os.path.join(img_dir, d, "metadata.json"))
        except (OSError, ValueError):
            unreadable += 1
            continue
        if m.get("id") != d[:-5]:
            unreadable += 1
            continue
        items.append(m)
    return items, total, unreadable


def original_path(lib, m):
    return os.path.join(lib, "images", m["id"] + ".info", f"{m.get('name')}.{m.get('ext')}")


def usable(lib, m):
    if str(m.get("ext", "")).lower() not in IMAGE_EXTS:
        return False
    p = original_path(lib, m)
    try:
        return 0 < os.path.getsize(p) <= MAX_FILE
    except OSError:
        return False


def library_profile(items, total, unreadable, root):
    """只含计数：画师 Eagle 的使用习惯与规模。"""
    c = lambda f: sum(1 for m in items if f(m))
    exts = {}
    for m in items:
        e = str(m.get("ext", "")).lower()
        exts[e] = exts.get(e, 0) + 1

    def count_folders(fs):
        return sum(1 + count_folders(f.get("children", [])) for f in fs)
    return {
        "条目总数": total, "读取的条目": len(items), "读取失败": unreadable,
        "读取部分的原文件总大小（MB）": round(sum(m.get("size") or 0 for m in items) / 2**20, 1),
        "扩展名分布": dict(sorted(exts.items(), key=lambda kv: -kv[1])),
        "有区域评论": c(lambda m: m.get("comments")), "有链接": c(lambda m: m.get("url")),
        "有备注": c(lambda m: m.get("annotation")), "属于多个文件夹": c(lambda m: len(m.get("folders") or []) > 1),
        "没有任何文件夹": c(lambda m: not m.get("folders")), "有标签": c(lambda m: m.get("tags")),
        "平均标签数": round(sum(len(m.get("tags") or []) for m in items) / max(1, len(items)), 2),
        "有评分": c(lambda m: m.get("star")), "在 Eagle 回收站": c(lambda m: m.get("isDeleted")),
        "文件夹数": count_folders(root.get("folders", [])), "智能文件夹数": len(root.get("smartFolders", []) or []),
        "标签组数": len(root.get("tagsGroups", []) or []), "快速访问数": len(root.get("quickAccess", []) or []),
        "条目元数据字段": sorted({k for m in items for k in m}),
    }


def pick_sample(lib, items, n, budget, rnd):
    """先按特征分层挑（区域评论、多文件夹、链接、备注、回收站、透明／动图格式、极端比例、大文件），再随机补满。"""
    ok = [m for m in items if usable(lib, m)]
    rnd.shuffle(ok)
    strata = [
        ("区域评论", lambda m: m.get("comments"), 15), ("多文件夹", lambda m: len(m.get("folders") or []) > 1, 10),
        ("链接", lambda m: m.get("url"), 10), ("备注", lambda m: m.get("annotation"), 10),
        ("回收站", lambda m: m.get("isDeleted"), 5), ("PNG", lambda m: str(m.get("ext")).lower() == "png", 10),
        ("其他格式", lambda m: str(m.get("ext")).lower() not in ("jpg", "jpeg", "png"), 10),
        ("极端比例", lambda m: (m.get("width") or 0) and (m.get("height") or 0)
         and max(m["width"] / m["height"], m["height"] / m["width"]) >= 3, 5),
        ("大文件", lambda m: (m.get("size") or 0) >= 10 * 2**20, 3), ("多标签", lambda m: len(m.get("tags") or []) >= 5, 10),
    ]
    chosen, ids, used = [], set(), 0

    def take(m):
        nonlocal used
        sz = m.get("size") or os.path.getsize(original_path(lib, m))
        if m["id"] in ids or used + sz > budget or len(chosen) >= n:
            return False
        chosen.append(m)
        ids.add(m["id"])
        used += sz
        return True
    strata_hit = {}
    for name, f, k in strata:
        got = 0
        for m in ok:
            if got >= k:
                break
            if f(m) and take(m):
                got += 1
        strata_hit[name] = got
    # 同库内字节相同的原图（真实重复）：按大小分组，再确认哈希
    by_size = {}
    for m in ok:
        by_size.setdefault(m.get("size"), []).append(m)
    dup_pairs = 0
    for size, ms in by_size.items():
        if len(ms) < 2 or dup_pairs >= 2:
            continue
        hashes = {}
        for m in ms[:6]:
            hashes.setdefault(ks.sha256_file(original_path(lib, m)), []).append(m)
        for same in hashes.values():
            if len(same) >= 2 and dup_pairs < 2:
                if all(take(x) or x["id"] in ids for x in same[:2]):
                    dup_pairs += 1
    for m in ok:
        if len(chosen) >= n:
            break
        take(m)
    strata_hit["同库真实重复（对）"] = dup_pairs
    return chosen, strata_hit, used, len(ok)


def copy_library(src, dst, metas, root_override=None):
    os.makedirs(os.path.join(dst, "images"), exist_ok=True)
    root = root_override if root_override is not None else read_json(os.path.join(src, "metadata.json"))
    write_json(os.path.join(dst, "metadata.json"), root)
    for extra in ("tags.json",):
        if os.path.exists(os.path.join(src, extra)):
            shutil.copyfile(os.path.join(src, extra), os.path.join(dst, extra))
    try:
        src_mt = read_json(os.path.join(src, "mtime.json"))
    except (OSError, ValueError):
        src_mt = {}
    for m in metas:
        shutil.copytree(os.path.join(src, "images", m["id"] + ".info"), os.path.join(dst, "images", m["id"] + ".info"))
    write_mtime(dst, {m["id"]: src_mt.get(m["id"], m.get("modificationTime", 0)) for m in metas})


def write_mtime(lib, mt):
    mt = {k: v for k, v in mt.items() if k != "all"}
    mt["all"] = len(mt)
    write_json(os.path.join(lib, "mtime.json"), mt)


def add_to_mtime(lib, iid, value):
    mt = read_json(os.path.join(lib, "mtime.json"))
    mt[iid] = value
    write_mtime(lib, mt)


def drop_from_mtime(lib, iid):
    mt = read_json(os.path.join(lib, "mtime.json"))
    mt.pop(iid, None)
    write_mtime(lib, mt)


def item_meta_path(lib, iid):
    return os.path.join(lib, "images", iid + ".info", "metadata.json")


def clone_item(src_lib, iid, dst_lib, new_id, *, extra_bytes=b"", edit=None):
    """复制一个条目到 dst_lib，换成新 ID（可追加字节使内容不同）。用于合成同库重复、两库共有与新增条目。"""
    m = read_json(item_meta_path(src_lib, iid))
    sd, dd = os.path.join(src_lib, "images", iid + ".info"), os.path.join(dst_lib, "images", new_id + ".info")
    shutil.copytree(sd, dd)
    m["id"] = new_id
    if extra_bytes:
        p = original_path(dst_lib, m)
        with open(p, "ab") as f:
            f.write(extra_bytes)
        m["size"] = os.path.getsize(p)
    if edit:
        edit(m)
    write_json(item_meta_path(dst_lib, new_id), m)
    add_to_mtime(dst_lib, new_id, m.get("modificationTime", 0))
    return m


def walk_folders(fs):
    for f in fs:
        yield f
        yield from walk_folders(f.get("children", []))


# ====================== 硬件与环境（只记录型号与容量） ======================

def hardware():
    info = {"系统": platform.platform(), "处理器": platform.processor(), "逻辑核心": os.cpu_count()}
    if os.name == "nt":
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        ms = MS()
        ms.dwLength = ctypes.sizeof(MS)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
            info["内存（GB）"] = round(ms.ullTotalPhys / 2**30, 1)
    return info


# ====================== 主流程 ======================

def run(args):
    rnd = random.Random(args.seed)
    W = workspace(args.work)
    SCRUB.extend([(W, "<工作区>"), (os.path.expanduser("~"), "<用户目录>")])
    say("# Kinshoko Eagle 往返检查（#8）")
    say()
    say(f"工具版本 {TOOL_VERSION}；随机种子 {args.seed}；开始于 {ks.now()}。")

    # ---------------------------------------------------------------- 0. 找库
    section("0. 找到 Eagle 资料库")
    libs, how = discover(args.library)
    metrics["找库方式"] = how
    if not libs:
        raise SystemExit("没有找到 Eagle 资料库。可以把资料库文件夹（以 .library 结尾）拖到本程序图标上再运行。")
    for i, l in enumerate(libs):
        SCRUB.append((l["path"], f"<资料库{i + 1}>"))
        print(f"  [{i + 1}] {l['path']} —— {l['items']} 项，Eagle {l['version']}")
    say(f"找到 {len(libs)} 个资料库，条目数 {[l['items'] for l in libs]}，Eagle 版本 {sorted({str(l['version']) for l in libs})}。")
    pick = 0
    if len(libs) > 1 and not args.yes:
        ans = input("用哪个库做主样本？直接回车＝[1]（最大的那个）：").strip()
        if ans.isdigit() and 1 <= int(ans) <= len(libs):
            pick = int(ans) - 1
    main_lib = libs[pick]
    second = next((l for i, l in enumerate(libs) if i != pick and l["items"] > 0), None)
    metrics["资料库条目数"] = [l["items"] for l in libs]
    metrics["Eagle 版本"] = main_lib["version"]
    if not str(main_lib["version"] or "").startswith("4."):
        notes.append(f"主样本库的 Eagle 版本是 {main_lib['version']}，原型的字段映射按 4.x 写成；结果仍有效，但字段差异需留意。")
    if how.get("eagle_running"):
        notes.append("运行时 Eagle 开着。程序只读原库；若复制期间 Eagle 正在写入，可能读到半写的元数据，这会如实记成失败项。")

    # ---------------------------------------------------------------- 1. 挑样本
    section("1. 从画师的库里挑样本并复制")
    src = main_lib["path"]
    guard = {f: os.path.getmtime(os.path.join(src, f)) for f in ("metadata.json", "mtime.json") if os.path.exists(os.path.join(src, f))}
    print("正在读取资料库元数据……", flush=True)
    (items, total, unreadable), t_scan = timed(scan_items, src, args.scan_cap, rnd)
    src_root = read_json(os.path.join(src, "metadata.json"))
    metrics["主样本库概况"] = library_profile(items, total, unreadable, src_root)
    metrics["读取元数据耗时（秒）"] = t_scan
    free = shutil.disk_usage(os.path.dirname(W) if not os.path.exists(W) else W).free
    budget = min(args.budget_mb * 2**20, free // 6)
    sample, strata, used, n_usable = pick_sample(src, items, args.count, budget, rnd)
    if len(sample) < 20:
        raise SystemExit(f"可用的图片只有 {len(sample)} 张（需要至少 20 张）。可能是磁盘空间不足或库里图片太少。")
    metrics["样本"] = {"张数": len(sample), "原文件总大小（MB）": round(used / 2**20, 1), "可用图片": n_usable, "分层命中": strata}
    say(f"可用图片 {n_usable} 张，挑出 {len(sample)} 张（{round(used / 2**20)} MB）。分层命中：{strata}")

    shutil.rmtree(ks.lp(W), ignore_errors=True)
    os.makedirs(W)
    SRC = os.path.join(W, "sources")
    eA = os.path.join(SRC, "甲.library")
    print("正在复制样本（只读原库）……", flush=True)
    _, t_copy = timed(copy_library, src, eA, sample)
    metrics["复制样本耗时（秒）"] = t_copy

    # 乙：另一个真实库的样本；没有第二个库时用主库里没挑中的图
    if second:
        s_items, _, _ = scan_items(second["path"], 3000, rnd)
        s_pick = [m for m in s_items if usable(second["path"], m)][:30]
        copy_library(second["path"], os.path.join(SRC, "乙.library"), s_pick)
        say(f"乙：取自另一个真实资料库，{len(s_pick)} 张。")
    else:
        rest = [m for m in items if m["id"] not in {x["id"] for x in sample} and usable(src, m)][:30]
        copy_library(src, os.path.join(SRC, "乙.library"), rest)
        say(f"乙：只有一个资料库，取主库中未挑中的 {len(rest)} 张。")
        synthesized.append("乙库的条目取自主库里没挑中的图（画师只有一个资料库）")
    eB = os.path.join(SRC, "乙.library")
    changed = [f for f, t in guard.items() if os.path.getmtime(os.path.join(src, f)) != t]
    if changed:
        notes.append(f"复制期间 Eagle 改动了原库的 {changed}；样本按复制时的状态检查。")

    # 合成：同库重复、两库共有、回收站
    a_items = {m["id"]: read_json(item_meta_path(eA, m["id"])) for m in sample}
    sha_of = {iid: ks.sha256_file(original_path(eA, m)) for iid, m in a_items.items()}
    counts = {}
    for s in sha_of.values():
        counts[s] = counts.get(s, 0) + 1
    real_dup = [iid for iid, s in sha_of.items() if counts[s] > 1]
    plain = [iid for iid, m in a_items.items() if counts[sha_of[iid]] == 1 and not m.get("isDeleted")
             and (m.get("width") or 0) > 0 and (m.get("height") or 0) > 0]
    rnd.shuffle(plain)
    reserved = set()

    def take_plain(pred=lambda m: True):
        for iid in plain:
            if iid not in reserved and pred(a_items[iid]):
                reserved.add(iid)
                return iid
        raise SystemExit("样本里不重复的普通图片不够，无法完成检查。")
    if real_dup:
        dup_ids = real_dup
        say(f"同库重复：样本中有 {len(real_dup)} 个条目与别的条目字节相同（真实数据）。")
    else:
        base = take_plain()
        clone = clone_item(eA, base, eA, eagle_like_id(rnd))
        dup_ids = [base, clone["id"]]
        a_items[clone["id"]] = clone
        sha_of[clone["id"]] = sha_of[base]
        synthesized.append("同库重复：复制一个条目并换成新 ID（画师样本里没有字节相同的两项）")
    trashed_real = [iid for iid, m in a_items.items() if m.get("isDeleted") and counts.get(sha_of[iid], 1) == 1]
    if not trashed_real:
        t_id = take_plain()
        p = item_meta_path(eA, t_id)
        m = read_json(p)
        m["isDeleted"] = True
        write_json(p, m)
        a_items[t_id] = m
        trashed_real = [t_id]
        synthesized.append("Eagle 回收站：把一个条目标成 isDeleted（样本里没有回收站中的图）")
    shared = []
    for _ in range(2):
        base = take_plain()
        cid = eagle_like_id(rnd)
        clone_item(eA, base, eB, cid, edit=lambda m: m.update(tags=["乙库自己的标签"], folders=[]))
        shared.append((base, cid))
    synthesized.append("两库共有原图：把甲的 2 个条目复制进乙（新 ID、乙自己的标签）")
    has_comments = [iid for iid, m in a_items.items() if m.get("comments")]
    if not has_comments:
        cid = take_plain()
        p = item_meta_path(eA, cid)
        m = read_json(p)
        w, h = m["width"], m["height"]
        m["comments"] = [{"id": "KSYNC1", "x": int(w * .2), "y": int(h * .2), "width": int(w * .2), "height": int(h * .2),
                          "annotation": "合成的区域评论", "lastModified": 1760000000000}]
        write_json(p, m)
        a_items[cid] = m
        synthesized.append("区域评论：样本里没有，给一个条目加了合成评论（只验证保存往返，不验证坐标基准）")
    metrics["真实区域评论"] = sum(len(m.get("comments") or []) for m in a_items.values() if not any(
        c.get("id") == "KSYNC1" for c in m.get("comments") or []))

    # 丙：普通文件导入（从甲复制几张原文件出来）
    c_dir = os.path.join(SRC, "散图")
    os.makedirs(c_dir)
    c_files = []
    for i in range(3):
        iid = take_plain()
        m = a_items[iid]
        dst = os.path.join(c_dir, f"file{i}.{m['ext']}")
        shutil.copyfile(original_path(eA, m), dst)
        with open(dst, "ab") as f:
            f.write(b"\0kinshoko-plain-" + bytes([i]))  # 与甲不同字节
        c_files.append(dst)

    # ---------------------------------------------------------------- 2. 首次导入
    section("2. 首次导入")
    D1 = os.path.join(W, "device1")
    dev = ks.Device(D1)
    A = ks.Library.create(os.path.join(D1, "libraries", "甲"), "甲")
    B = ks.Library.create(os.path.join(D1, "libraries", "乙"), "乙")
    C = ks.Library.create(os.path.join(D1, "libraries", "丙"), "丙")
    for lib in (A, B, C):
        dev.register_library(lib)
    ra, t_imp = timed(A.import_eagle, eA, allow_any_version=True)
    rb = B.import_eagle(eB, allow_any_version=True)
    rc = C.import_files(c_files)
    metrics["甲首次导入耗时（秒）"] = t_imp
    metrics["甲首次导入每张（毫秒）"] = round(t_imp * 1000 / max(1, ra["seen"]), 1)
    for n, r in (("甲（Eagle）", ra), ("乙（Eagle）", rb), ("丙（普通文件）", rc)):
        say(f"- {n}：{r['status']}，成功 {r['ok']}，失败 {r['failed']}，结果 {r['outcomes']}")
    reasons = sorted({f[1].split("（")[0] for f in ra["failures"] + rb["failures"]})
    gate("导入规则", "每一项要么导入成功，要么给出失败原因", ra["ok"] + ra["failed"] == ra["seen"] and rb["ok"] + rb["failed"] == rb["seen"],
         f"失败原因 {reasons}" if reasons else "全部成功")
    if ra["failed"]:
        notes.append(f"画师的真实数据里有 {ra['failed']} 项导入失败，原因 {reasons}。需要看是数据问题还是导入规则问题。")

    # 逐字段核对
    field_import, field_total = {}, {}
    for iid, meta in a_items.items():
        image_id = A.image_by_external(iid)
        if image_id is None:
            continue
        v = A.image_view(image_id)
        b = next(x for x in v["bindings"] if x["external_id"] == iid)
        single = len(v["bindings"]) == 1
        for k, val in meta.items():
            ok = b["raw"].get(k) == val
            if k == "tags":
                ok = ok and set(val or []) <= set(v["tags_effective"])
            elif k == "folders":
                known = [f for f in val or [] if A.one("SELECT id FROM folder WHERE source_key=?", f"{b['source']}:{f}")]
                paths = {A.folder_path(A.one("SELECT id FROM folder WHERE source_key=?", f"{b['source']}:{f}")) for f in known}
                ok = ok and paths <= set(v["folders_effective"])
            elif k == "comments":
                mine = [n for n in v["region_notes"] if n["raw"] in (val or [])]
                ok = ok and len(mine) == len(val or []) and all(
                    (n["x"], n["y"], n["w"], n["h"], n["text"]) == (n["raw"].get("x"), n["raw"].get("y"), n["raw"].get("width"),
                                                                   n["raw"].get("height"), n["raw"].get("annotation")) for n in mine)
            elif k == "isDeleted" and single:
                ok = ok and (b["state"] == "trashed") == bool(val) and (v["status"] == "trashed") == bool(val)
            elif k == "size":
                ok = ok and v["size"] == val
            elif k in ("width", "height", "ext") and single:
                ok = ok and v[k] == val
            elif k == "name":
                ok = ok and (v["original_name"] == val or not single)
            field_import[k] = field_import.get(k, 0) + bool(ok)
            field_total[k] = field_total.get(k, 0) + 1
        ok_sha = sha_of[iid] == v["sha256"] == ks.sha256_file(A.file(v["rel_path"]))
        field_import["(原文件 SHA-256)"] = field_import.get("(原文件 SHA-256)", 0) + ok_sha
        field_total["(原文件 SHA-256)"] = field_total.get("(原文件 SHA-256)", 0) + 1
    bad_fields = sorted(k for k in field_total if field_import[k] != field_total[k])
    gate("字段往返", f"Eagle 单项字段导入后全部可取回（{len(field_total)} 个字段，按条目计）", not bad_fields,
         "不一致：" + ", ".join(f"{k} {field_total[k] - field_import[k]}/{field_total[k]}" for k in bad_fields) if bad_fields else "")
    gate("原文件", "导入后每个原文件 SHA-256 与 Eagle 中一致", field_import["(原文件 SHA-256)"] == field_total["(原文件 SHA-256)"],
         f"{field_total['(原文件 SHA-256)']} 项")
    root_a = read_json(os.path.join(eA, "metadata.json"))
    raw_lib = json.loads(A.one("SELECT raw_library_json FROM import_source WHERE kind='eagle'"))
    lib_fields = {k: raw_lib.get(k) == val for k, val in root_a.items()}
    n_folders = len(list(walk_folders(root_a.get("folders", []))))
    lib_fields["folders"] = lib_fields.get("folders", True) and A.one("SELECT count(*) FROM folder") == n_folders
    gate("字段往返", f"Eagle 库级字段导入后全部可取回（{len(lib_fields)} 个字段，含 {n_folders} 个文件夹的层级）", all(lib_fields.values()),
         ", ".join(k for k, ok in lib_fields.items() if not ok))

    dup_images = {A.image_by_external(i) for i in dup_ids if A.image_by_external(i)}
    by_sha = {}
    for i in dup_ids:
        by_sha.setdefault(sha_of[i], []).append(A.image_by_external(i))
    gate("导入规则", "同库两个 Eagle 条目是同一原图 → 汇成一条图片记录，两份来源各自保留",
         all(len(set(v)) == 1 for v in by_sha.values()) and all(len(A.image_view(i)["bindings"]) >= 2 for i in dup_images),
         f"{len(dup_ids)} 个条目 → {len(dup_images)} 条记录")
    sh_ok = all(A.image_view(A.image_by_external(a))["sha256"] == B.image_view(B.image_by_external(b))["sha256"]
                and A.image_view(A.image_by_external(a))["tags_effective"] != B.image_view(B.image_by_external(b))["tags_effective"]
                for a, b in shared)
    gate("导入规则", "两个资料库含相同原图 → 各自一条记录、各自整理，原文件字节相同", sh_ok, f"{len(shared)} 对")
    gate("导入规则", "Eagle 回收站中的图导入为本库的可恢复删除状态",
         all(A.image_view(A.image_by_external(i))["status"] == "trashed" for i in trashed_real), f"{len(trashed_real)} 项")
    rn = A.one("SELECT count(*) FROM region_note")
    gate("导入规则", "区域评论保留原始坐标，标注为未核验基准",
         rn == sum(len(m.get("comments") or []) for m in a_items.values()) and A.one("SELECT count(*) FROM region_note WHERE basis<>'eagle-raw-unverified'") == 0,
         f"{rn} 条")

    # 批量试验用的纯净副本（在模拟 Eagle 改动之前复制）
    bulk_ids = [i for i in plain if i not in reserved][:60]
    eBulk = os.path.join(SRC, "批量.library")
    copy_library(eA, eBulk, [a_items[i] for i in bulk_ids])

    # ---------------------------------------------------------------- 3. 人工整理与参考组
    section("3. 人工整理与参考组")
    a1 = take_plain(lambda m: m.get("tags")) if any(a_items[i].get("tags") for i in plain if i not in reserved) else take_plain()
    a2, a3, a5, a6, a8 = (take_plain() for _ in range(5))
    has_folder = lambda m: m.get("folders")
    f_host = take_plain(has_folder) if any(has_folder(a_items[i]) for i in plain if i not in reserved) else take_plain()
    img = {k: A.image_by_external(v) for k, v in dict(a1=a1, a2=a2, a3=a3, a5=a5, a6=a6, a8=a8).items()}
    tags_a1 = A.image_view(img["a1"])["tags_effective"]
    if tags_a1:
        A.decide_tag(img["a1"], tags_a1[0], "reject")
    A.decide_tag(img["a1"], "Kinshoko测试标签", "add")
    A.set_note(img["a1"], "Kinshoko 本库备注")
    A.set_status(img["a3"], "trashed")
    say("- 甲：一张图否决一个标签、添加一个标签、写本库备注；另一张进入可恢复删除。")
    b_shared = B.image_by_external(shared[0][1])
    shared_b = {B.image_by_external(c) for _, c in shared}
    b_other = next(x for (x,) in B.q("SELECT image_id FROM source_binding ORDER BY external_id") if x not in shared_b)
    c_imgs = [C.image_by_external(os.path.basename(p)) for p in c_files]
    GD = os.path.join(D1, "groups")
    os.makedirs(GD)
    G = {}

    def crop(lib, image_id, fx, fy, fw, fh):
        w, h = lib.db.execute("SELECT width, height FROM image WHERE id=?", (image_id,)).fetchone()
        return {"x": int(w * fx), "y": int(h * fy), "w": max(1, int(w * fw)), "h": max(1, int(h * fh))}

    def mk_group(name, members):
        g = ks.new_group(name)
        for lib, iid, cr, x, y, s in members:
            ks.add_member(g, lib, iid, cr, x, y, s)
        p = os.path.join(GD, name + ".json")
        ks.save_group(p, g)
        dev.register_group(p)
        G[name] = (p, g)
        say(f"- 参考组「{name}」：{len(g['members'])} 个成员，引用 {sorted({lib.name for lib, *_ in members}) or '无'}")
        return g
    mk_group("跨库参考", [(A, img["a1"], crop(A, img["a1"], .1, .1, .3, .3), 0, 0, 2.0),
                       (A, img["a1"], crop(A, img["a1"], .55, .2, .3, .3), 300, 0, 2.0),
                       (A, img["a2"], None, 0, 300, 0.5), (B, b_shared, None, 300, 300, 0.5)])
    mk_group("乙与散图", [(B, b_other, None, 0, 0, 1.0), (C, c_imgs[0], None, 300, 0, 1.0)])
    mk_group("散图", [(C, c_imgs[1], None, 0, 0, 1.0)])
    mk_group("空组", [])
    g_x = G["跨库参考"][1]
    gate("参考组", "同图两个局部是两个成员，裁切各自保存", g_x["members"][0]["member_id"] != g_x["members"][1]["member_id"]
         and g_x["members"][0]["crop"] != g_x["members"][1]["crop"])

    # ---------------------------------------------------------------- 4. 模拟 Eagle 继续整理后重导
    section("4. 模拟画师在 Eagle 里继续整理，然后重导")
    p = item_meta_path(eA, a1)
    m = read_json(p)
    m["tags"] = list(m.get("tags") or []) + ["Eagle新增标签"]
    m["annotation"] = (m.get("annotation") or "") + "（Eagle 里改过）"
    write_json(p, m)
    p = item_meta_path(eA, a2)
    m = read_json(p)
    with open(original_path(eA, m), "ab") as f:
        f.write(b"\0kinshoko-content-changed")
    m["size"] = os.path.getsize(original_path(eA, m))
    write_json(p, m)
    shutil.rmtree(os.path.join(eA, "images", a5 + ".info"))
    drop_from_mtime(eA, a5)
    p = item_meta_path(eA, a6)
    m = read_json(p)
    m["isDeleted"] = True
    write_json(p, m)
    clone_item(eA, a8, eA, eagle_like_id(rnd), extra_bytes=b"\0kinshoko-new-item")
    renamed = None
    host_folders = [f for f in a_items[f_host].get("folders") or [] if any(x["id"] == f for x in walk_folders(root_a.get("folders", [])))]
    if host_folders:
        root2 = read_json(os.path.join(eA, "metadata.json"))
        for f in walk_folders(root2["folders"]):
            if f["id"] == host_folders[0]:
                f["name"] = renamed = f["name"] + "（改名）"
        write_json(os.path.join(eA, "metadata.json"), root2)
    say("模拟的 Eagle 改动：一张图加标签并改备注；一张图换了内容；一张彻底删除；一张移入回收站；新增一张"
        + ("；一个文件夹改名。" if renamed else "。（样本里没有归属文件夹的图，跳过文件夹改名）"))
    n_before = A.one("SELECT count(*) FROM image")
    r2 = A.import_eagle(eA, allow_any_version=True)
    say(f"- 重导：{r2['status']}，结果 {r2['outcomes']}，标记缺失 {len(r2['marked_missing'])} 项")
    va1 = A.image_view(img["a1"])
    b1 = next(b for b in va1["bindings"] if b["external_id"] == a1)
    gate("重导", "人工否决／添加与本库备注在重导后保留，Eagle 新标签与新备注进入",
         (not tags_a1 or tags_a1[0] not in va1["tags_effective"]) and "Kinshoko测试标签" in va1["tags_effective"]
         and "Eagle新增标签" in va1["tags_effective"] and va1["note_manual"] == "Kinshoko 本库备注"
         and b1["raw"]["annotation"].endswith("（Eagle 里改过）"))
    new_a2 = A.image_by_external(a2)
    va2_new, va2_old = A.image_view(new_a2), A.image_view(img["a2"])
    gate("重导", "来源内容变化 → 新图片记录并指向旧版本；旧版本与引用它的参考组成员不受影响",
         new_a2 != img["a2"] and va2_new["previous_image_id"] == img["a2"] and va2_old["bindings"][0]["state"] == "superseded"
         and dev.resolve_member(g_x["members"][2])["status"] == "ok")
    gate("重导", "来源彻底删除 → 标记缺失，本库副本与原文件保留",
         A.image_view(img["a5"])["bindings"][0]["state"] == "missing" and not A.verify())
    va6 = A.image_view(img["a6"])
    gate("重导", "来源移入 Eagle 回收站 → 来源状态 trashed，本库状态不随之改变", va6["bindings"][0]["state"] == "trashed" and va6["status"] == "active")
    if renamed:
        gate("重导", "文件夹改名后归属不变、名称更新", any(p.split("/")[-1] == renamed for p in A.image_view(A.image_by_external(f_host))["folders_effective"]))
    else:
        skip("重导", "文件夹改名后归属不变、名称更新", "样本里没有归属文件夹的图")
    gate("重导", "重导不重复创建已有记录", A.one("SELECT count(*) FROM image") == n_before + 2,
         f"{n_before} → {A.one('SELECT count(*) FROM image')}（+1 新图，+1 新版本）")

    moved = eA + "-搬到别处"
    os.rename(eA, moved)
    n_before = A.one("SELECT count(*) FROM image")
    dump_before = A.canonical_dump()
    ask = A.import_eagle(moved, allow_any_version=True)
    gate("重导", "资料库整体搬家后重导 → 先请用户确认是否同一来源，确认前不写任何数据",
         ask["status"] == "needs_confirmation" and A.canonical_dump() == dump_before, f"外部 ID 重合 {ask.get('candidate', {}).get('overlap')}")
    r3 = A.import_eagle(moved, source=ask["candidate"]["source_id"], allow_any_version=True) if ask["status"] == "needs_confirmation" else {"relocated": None, "outcomes": {}}
    gate("重导", "确认是同一来源 → 沿用来源登记并更新位置，不新建记录",
         r3["relocated"] and A.one("SELECT count(*) FROM image") == n_before and set(r3["outcomes"]) == {"refreshed"}, f"结果 {r3['outcomes']}")
    moved_b = eB + "-副本"
    shutil.copytree(eB, moved_b)
    nb_before = B.one("SELECT count(*) FROM image")
    ask_b = B.import_eagle(moved_b, allow_any_version=True)
    rb2 = B.import_eagle(moved_b, source="new", allow_any_version=True)
    gate("重导", "确认是另一个来源 → 新登记来源；相同原图汇入已有记录，不重复创建",
         ask_b["status"] == "needs_confirmation" and B.one("SELECT count(*) FROM import_source") == 2
         and B.one("SELECT count(*) FROM image") == nb_before and set(rb2["outcomes"]) <= {"merged_same_original"}, f"结果 {rb2['outcomes']}")

    # ---------------------------------------------------------------- 5. 来源离线
    section("5. 来源库离线时的参考组")
    grp_hash = ks.sha256_file(G["跨库参考"][0])
    L = {"A": A.id, "B": B.id, "C": C.id}
    b_path = B.path
    dev.close()
    os.rename(b_path, b_path + "-离线")
    r = dev.resolve_member(g_x["members"][3])
    dev.close()
    os.rename(b_path + "-离线", b_path)
    A, B, C = (dev.library(L[k]) for k in "ABC")
    gate("参考组", "乙离线 → 用甲中字节相同的原图临时补足显示，组文件不被改写",
         r["status"] == "filled" and r.get("from_library") == A.id and ks.sha256_file(G["跨库参考"][0]) == grp_hash, f"{r['status']}")

    # ---------------------------------------------------------------- 6. 备份范围
    section("6. 备份范围（Q43）")
    mk_group("闭环", [(C, c_imgs[2], None, 0, 0, 1.0), (A, img["a8"], None, 300, 0, 1.0)])
    name_of_lib = {lib.id: lib.name for lib in (A, B, C)}
    name_of_group = {g["group_id"]: g["name"] for _, g in dev.groups()}

    def scope(sel=None, extend=True):
        sc = ks.compute_scope(dev, sel, extend)
        return ({name_of_lib[x] for x in sc["libraries"]}, {name_of_group[g] for g in sc["groups"]},
                {(g, name_of_lib[x]) for g, x in sc["uncovered"]}, sc)
    la, ga, _, sc_all = scope()
    gate("备份范围", "默认包含全部已登记库与组，包括不引用任何库的组", la == {"甲", "乙", "丙"} and ga == {"跨库参考", "乙与散图", "散图", "空组", "闭环"})
    la, ga, _, _ = scope([L["A"]], True)
    gate("备份范围", "甲/乙、乙/丙 关联链与 丙/甲 闭环：一次算清并终止", la == {"甲", "乙", "丙"} and ga == {"跨库参考", "乙与散图", "散图", "闭环"})
    la, ga, ua, _ = scope([L["A"]], False)
    gate("备份范围", "拒绝补选时列明未覆盖内容", la == {"甲"} and ga == {"跨库参考", "闭环"} and ua == {("跨库参考", "乙"), ("闭环", "丙")})
    lb, gb, ub, _ = scope([L["B"]], False)
    gate("备份范围", "从链中间开始：两侧外库都列为未覆盖", lb == {"乙"} and gb == {"跨库参考", "乙与散图"} and ub == {("跨库参考", "甲"), ("乙与散图", "丙")})
    metrics["默认备份预估容量（MB）"] = round(ks.scope_size(dev, sc_all) / 2**20, 1)

    # ---------------------------------------------------------------- 7. 备份与恢复
    section("7. 默认备份 → 恢复为独立库与组")
    pre_dump = {lid: dev.library(lid).canonical_dump() for lid in dev.reg["libraries"]}
    pre_views = {lid: {i: dev.library(lid).image_view(i) for (i,) in dev.library(lid).q("SELECT id FROM image")} for lid in dev.reg["libraries"]}
    pre_groups = {g["group_id"]: g for _, g in dev.groups()}
    pre_group_hashes = {p: ks.sha256_file(p) for p in dev.reg["groups"]}
    BK = os.path.join(W, "backups")
    os.makedirs(BK)
    (bdir, _), t_backup = timed(ks.backup, dev, BK, ks.compute_scope(dev))
    metrics["默认备份耗时（秒）"] = t_backup
    metrics["默认备份容量（MB）"] = round(sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(bdir) for f in fs) / 2**20, 1)
    gate("备份恢复", "备份完成并通过自检", not ks.verify_backup(bdir))
    D2 = os.path.join(W, "device2-恢复后")
    dev2 = ks.Device(D2)
    mapping, t_restore = timed(ks.restore, bdir, dev2)
    metrics["默认恢复耗时（秒）"] = t_restore
    dump_ok = view_ok = sha_ok = True
    for old, new in mapping["libraries"].items():
        nl = dev2.library(new)
        dump_ok &= nl.canonical_dump() == pre_dump[old]
        for i, v in pre_views[old].items():
            view_ok &= nl.image_view(i) == v
        sha_ok &= not nl.verify()
    gate("字段往返", "恢复后每个库的全部表逐行一致（库身份除外）", dump_ok)
    gate("字段往返", "恢复后每张图片的完整视图一致（标签、人工决定、文件夹、来源原始 JSON、区域评论、状态）", view_ok)
    gate("原文件", "恢复后每个原文件 SHA-256 与记录一致", sha_ok)
    grp_ok = resolve_ok = True
    for _, g in dev2.groups():
        old = pre_groups[g["restored_from"]["group_id"]]
        remapped = json.loads(json.dumps(old))
        for mm in remapped["members"]:
            mm["source"]["library_id"] = mapping["libraries"][mm["source"]["library_id"]]
        strip = lambda x: {k: v for k, v in x.items() if k not in ("group_id", "restored_from")}
        grp_ok &= strip(g) == strip(remapped) and g["group_id"] != old["group_id"]
        for mm in g["members"]:
            rr = dev2.resolve_member(mm)
            resolve_ok &= rr["status"] == "ok" and rr["path"].startswith(dev2.library(mm["source"]["library_id"]).fpath)
    gate("字段往返", "恢复出的组：新组身份，裁切／位置／缩放／视口一致，成员改连恢复出的库", grp_ok)
    gate("备份恢复", "恢复出的组的每个成员都能从恢复库取到原图", resolve_ok)
    gate("备份恢复", "恢复不改写原设备上现有的组", all(ks.sha256_file(p) == h for p, h in pre_group_hashes.items()))
    gate("备份恢复", "可恢复删除的图片也在备份中", any(dev2.library(x).one("SELECT count(*) FROM image WHERE status='trashed'") for x in dev2.reg["libraries"]))
    shutil.rmtree(ks.lp(bdir))  # 已验证，删掉省空间

    # ---------------------------------------------------------------- 8. 组包
    section("8. 跨库参考组打包 → 在空白位置打开")
    PK = os.path.join(W, "跨库参考.kinshoko-pack")
    g_x = ks.load_group(G["跨库参考"][0])[0]
    ks.export_package(dev, g_x, PK)
    pm, ppaths, pbad = ks.open_package(PK, os.path.join(W, "空白设备"))
    uniq = {mm["expected_sha256"] for mm in g_x["members"]}
    gate("原文件", "包内原文件 SHA-256 与成员预期一致，同一原图只带一次", not pbad and len(pm["files"]) == len(uniq),
         f"{len(g_x['members'])} 个成员，{len(pm['files'])} 个原文件")
    gate("参考组包", "脱离来源库打开：每个成员都能取到原图", all(os.path.exists(x) for x in ppaths.values()))
    snap = pm["snapshots"][f"{A.id}/{img['a1']}"]
    gate("参考组包", "带上所用图片的标签、备注、来源与区域评论快照；不带来源库其他素材",
         "Kinshoko测试标签" in snap["tags"] and snap["note_manual"] and snap["sources"][0]["url"] == read_json(item_meta_path(moved, a1)).get("url")
         and len(snap["region_notes"]) == len(read_json(item_meta_path(moved, a1)).get("comments") or [])
         and len(pm["snapshots"]) == len({(mm["source"]["library_id"], mm["source"]["image_id"]) for mm in g_x["members"]}))
    ng = ks.package_as_new_group(pm)
    gate("字段往返", "包另存为新组：新组身份，成员与布局逐字一致",
         ng["group_id"] != g_x["group_id"] and ng["members"] == g_x["members"] and ng["viewport"] == g_x["viewport"])
    shutil.rmtree(ks.lp(os.path.join(W, "空白设备")))

    # ---------------------------------------------------------------- 9. 中断与部分失败
    section("9. 写入中断与部分失败（Q38）")
    n_bulk = len(bulk_ids)
    n_broken = min(12, n_bulk // 5)
    if n_bulk < 15:
        skip("中断", "批量中断与部分失败", f"不重复的普通图片只有 {n_bulk} 张")
    else:
        broken = []
        for k in range(n_broken):
            iid = bulk_ids[k * (n_bulk // n_broken)]
            m = read_json(item_meta_path(eBulk, iid))
            d = os.path.join(eBulk, "images", iid + ".info")
            kind = ("missing_original", "bad_json", "size_mismatch")[k % 3]
            if kind == "missing_original":
                os.rename(original_path(eBulk, m), original_path(eBulk, m) + ".hidden")
            elif kind == "bad_json":
                os.rename(os.path.join(d, "metadata.json"), os.path.join(d, "metadata.json.good"))
                open(os.path.join(d, "metadata.json"), "w", encoding="utf-8").write('{"id": "' + iid + '", "name": ')
            else:
                os.rename(os.path.join(d, "metadata.json"), os.path.join(d, "metadata.json.good"))
                write_json(os.path.join(d, "metadata.json"), dict(m, size=(m.get("size") or 0) + 1))
            broken.append(kind)
        say(f"批量库 {n_bulk} 项（取自样本），其中 {n_broken} 项损坏：{sorted(set(broken))}。")
        D3 = os.path.join(W, "device3-批量")
        BL = ks.Library.create(os.path.join(D3, "批量"), "批量")
        BL.close()
        k_crash = n_bulk // 2
        code, err = child("import", {"lib": BL.path, "src": eBulk}, f"import_after_publish@{k_crash}")
        BL = ks.Library(BL.path)
        rec = BL.recover()
        say(f"- 第 {k_crash} 个原文件发布后、记录提交前杀进程（退出码 {code}）：已提交 {BL.one('SELECT count(*) FROM image')} 条；"
            f"未完成导入 {len(rec['interrupted_runs'])} 次、未登记原文件 {len(rec['orphan_originals'])} 个")
        gate("中断", "中断后打开：未完成的导入被标出，未登记原文件被报告而不删除",
             code == 99 and len(rec["interrupted_runs"]) == 1 and len(rec["orphan_originals"]) == 1, "" if code == 99 else f"子进程 {code}：{scrub(err)}")
        r1 = BL.import_eagle(eBulk, allow_any_version=True)
        gate("部分失败", "部分失败：保留成功项，整体标注部分成功，逐项列出失败原因",
             r1["status"] == "partial" and r1["ok"] == n_bulk - n_broken and r1["failed"] == n_broken
             and BL.one("SELECT count(*) FROM image") == n_bulk - n_broken, f"原因 {sorted({f[1].split('（')[0] for f in r1['failures']})}")
        gate("中断", "重试复用中断时已发布的原文件，不留孤立文件", r1["outcomes"].get("created_reused_file") == 1 and not BL.orphans())
        r1b = BL.import_eagle(eBulk, allow_any_version=True)
        gate("部分失败", "不修来源直接再试：不重复创建，失败项照旧报告",
             BL.one("SELECT count(*) FROM image") == n_bulk - n_broken and r1b["failed"] == n_broken and set(r1b["outcomes"]) == {"refreshed"})
        for d, _, files in os.walk(os.path.join(eBulk, "images")):
            for f in files:
                if f.endswith(".hidden"):
                    os.rename(os.path.join(d, f), os.path.join(d, f[:-7]))
                if f == "metadata.json.good":
                    os.replace(os.path.join(d, f), os.path.join(d, "metadata.json"))
        r1c = BL.import_eagle(eBulk, allow_any_version=True)
        dups = BL.one("SELECT count(*) FROM (SELECT sha256 FROM image GROUP BY sha256 HAVING count(*) > 1)")
        gate("部分失败", f"修好来源后重试：补齐 {n_broken} 项，总数 {n_bulk}，无重复记录",
             r1c["status"] == "ok" and BL.one("SELECT count(*) FROM image") == n_bulk and dups == 0)
        BL.close()
        BL2 = ks.Library.create(os.path.join(D3, "批量-事务中断"), "批量-事务中断")
        BL2.close()
        code, err = child("import", {"lib": BL2.path, "src": eBulk}, f"import_before_commit@{k_crash}")
        BL2 = ks.Library(BL2.path)
        BL2.recover()
        n2 = BL2.one("SELECT count(*) FROM image")
        r2b = BL2.import_eagle(eBulk, allow_any_version=True)
        gate("中断", "事务提交前被杀：该项整体回滚，重试后补齐且不重复",
             code == 99 and n2 == k_crash - 1 and r2b["status"] == "ok" and BL2.one("SELECT count(*) FROM image") == n_bulk and not BL2.orphans(),
             f"中断时 {n2} 条，重试后 {BL2.one('SELECT count(*) FROM image')} 条")
        BL2.close()
        shutil.rmtree(ks.lp(D3))

    gp = G["跨库参考"][0]
    before = open(ks.lp(gp), "rb").read()
    dev.close()
    code, _ = child("save_group", {"path": gp}, "group_before_replace@1")
    g_after, info = ks.load_group(gp)
    gate("中断", "保存参考组时被杀：旧版本完整可读，临时文件被识别",
         code == 99 and open(ks.lp(gp), "rb").read() == before and not info["problems"] and len(info["leftover_tmp"]) == 1)
    for t in info["leftover_tmp"]:
        os.remove(os.path.join(GD, t))
    code, _ = child("backup", {"dev": D1, "dest": BK}, "backup_mid_copy@5")
    inc = [d for d in os.listdir(BK) if d.endswith(".incomplete")]
    refused = False
    try:
        ks.restore(os.path.join(BK, inc[0]), ks.Device(os.path.join(W, "device4")))
    except (RuntimeError, IndexError):
        refused = True
    dev = ks.Device(D1)
    bdir2, _ = ks.backup(dev, BK, ks.compute_scope(dev))
    gate("中断", "备份复制中被杀：留下的半成品不会被当成完整备份，恢复拒绝；重跑得到完整备份",
         code == 99 and len(inc) == 1 and ks.verify_backup(os.path.join(BK, inc[0])) == ["incomplete"] and refused and not ks.verify_backup(bdir2))
    shutil.rmtree(ks.lp(BK))
    os.makedirs(BK)

    # ---------------------------------------------------------------- 10. 原文件被外部替换
    section("10. 库内原文件被外部替换")
    C = dev.library(L["C"])
    cp = C.file(C.one("SELECT rel_path FROM image WHERE id=?", c_imgs[1]))
    data = bytearray(open(cp, "rb").read())
    data[-1] ^= 0xFF
    open(cp, "wb").write(bytes(data))
    rr = dev.resolve_member(ks.load_group(G["散图"][0])[0]["members"][0])
    bdir3, bman3 = ks.backup(dev, BK, ks.compute_scope(dev))
    gate("原文件", "原文件字节被改：自检报告，成员不静默显示新内容，备份不标记为完整",
         C.verify() == [("content_mismatch", c_imgs[1])] and rr["status"] == "content_mismatch" and bdir3.endswith(".incomplete"))
    shutil.rmtree(ks.lp(BK))
    dev.close()

    # ---------------------------------------------------------------- 字段清单
    for k in sorted(field_total):
        field_rows.append((f"item.{k}" if not k.startswith("(") else k, f"{field_import[k]}/{field_total[k]}", view_ok))
    for k in sorted(lib_fields):
        field_rows.append((f"library.{k}", "✅" if lib_fields[k] else "❌", dump_ok))

    # ---------------------------------------------------------------- 浏览页
    write_browse(dev2, D2)
    dev2.close()
    return W, D2


def write_browse(dev2, D2):
    """恢复后的浏览页：引用工作区里的图片，不内嵌，只留在本机。"""
    import html as H
    out = ["<!doctype html><meta charset=utf-8><title>Kinshoko 恢复后浏览</title><style>"
           ":root{color-scheme:light dark}body{font:14px/1.5 system-ui,'Microsoft YaHei UI';margin:24px auto;max-width:1200px;padding:0 16px}"
           ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}"
           "figure{margin:0;font-size:12px}figure.tr{opacity:.45}.pic{position:relative}.pic img{width:100%;display:block;border-radius:4px}"
           ".box{position:absolute;border:2px solid #ff2d6f;box-shadow:0 0 0 1px #fff}.box span{position:absolute;top:-1.6em;left:0;background:#ff2d6f;color:#fff;padding:0 4px;white-space:nowrap;font-size:11px}"
           ".crop{width:220px;background-repeat:no-repeat;border-radius:4px;border:1px solid #8884}.note{background:#8881;padding:12px 16px;border-radius:8px}"
           "h2{margin-top:2em}</style>"
           "<h1>Kinshoko 恢复后浏览</h1><div class=note><p>这里的内容全部来自<b>备份后恢复出来的</b>独立资料库与参考组，图片来自你的 Eagle 样本副本。请看：</p><ol>"
           "<li>图片都能正常显示吗？颜色、方向和 Eagle 里一样吗？</li>"
           "<li>粉色框是 Eagle 里的<b>区域评论</b>。框的位置和你在 Eagle 里画的一致吗？（手机照片这类带旋转信息的图尤其要看）</li>"
           "<li>最下面的参考组里，局部截取的画面正常吗？</li></ol>"
           "<p>半透明的图是“可恢复删除”状态。看完回到黑色窗口回答问题。这个页面和图片只在你电脑上，不需要发回。</p></div>"]
    for lid in dev2.reg["libraries"]:
        lib = dev2.library(lid)
        rows = lib.q("SELECT id FROM image ORDER BY (SELECT count(*) FROM region_note r WHERE r.image_id=image.id) DESC, created_at")
        out.append(f"<h2>资料库 {H.escape(lib.name.split('-恢复-')[0])}（{len(rows)} 张）</h2><div class=grid>")
        for (iid,) in rows:
            v = lib.image_view(iid)
            rel = os.path.relpath(lib.file(v["rel_path"]).replace("\\\\?\\", ""), D2).replace("\\", "/")
            boxes = ""
            if v["width"] and v["height"]:
                for n in v["region_notes"]:
                    if n["w"] and n["h"]:
                        boxes += (f"<div class=box style='left:{n['x'] / v['width'] * 100:.2f}%;top:{n['y'] / v['height'] * 100:.2f}%;"
                                  f"width:{n['w'] / v['width'] * 100:.2f}%;height:{n['h'] / v['height'] * 100:.2f}%'><span>{H.escape(str(n['text'] or ''))[:20]}</span></div>")
            cap = "、".join(v["tags_effective"][:6]) + ("<br>文件夹：" + "；".join(v["folders_effective"][:2]) if v["folders_effective"] else "")
            out.append(f"<figure class={'tr' if v['status'] == 'trashed' else ''}><div class=pic><img loading=lazy src='{H.escape(rel)}'>{boxes}</div>"
                       f"<figcaption>{H.escape(cap)}</figcaption></figure>".replace("&lt;br&gt;", "<br>"))
        out.append("</div>")
    for _, g in dev2.groups():
        out.append(f"<h2>参考组：{H.escape(g['name'].split('-恢复-')[0])}</h2><div class=grid>")
        for m in g["members"]:
            r = dev2.resolve_member(m)
            if not r["path"]:
                out.append("<figure>（原图不可用）</figure>")
                continue
            rel = os.path.relpath(r["path"].replace("\\\\?\\", ""), D2).replace("\\", "/")
            c, (sw, sh) = m["crop"], (m["source_size"]["w"], m["source_size"]["h"])
            if c == "whole" or not (sw and sh):
                out.append(f"<figure><div class=pic><img loading=lazy src='{H.escape(rel)}'></div><figcaption>整图</figcaption></figure>")
            else:
                px = c["x"] / (sw - c["w"]) * 100 if sw != c["w"] else 0
                py = c["y"] / (sh - c["h"]) * 100 if sh != c["h"] else 0
                out.append(f"<figure><div class=crop style=\"aspect-ratio:{c['w']}/{c['h']};background-image:url('{H.escape(rel)}');"
                           f"background-size:{sw / c['w'] * 100:.2f}% {sh / c['h'] * 100:.2f}%;background-position:{px:.2f}% {py:.2f}%\"></div>"
                           f"<figcaption>局部（左上 {c['x']},{c['y']}，{c['w']}×{c['h']}）</figcaption></figure>")
        out.append("</div>")
    with open(os.path.join(D2, "browse.html"), "w", encoding="utf-8") as f:
        f.write("".join(out))


# ====================== 问题与报告 ======================

def ask_questions(has_real_comments):
    def yn(q):
        while True:
            a = input(q + "（y＝是 / n＝否 / 回车跳过）：").strip().lower()
            if a in ("y", "n", ""):
                return {"y": "是", "n": "否", "": "跳过"}[a]

    def choose(q, opts):
        print(q)
        for i, o in enumerate(opts, 1):
            print(f"  {i}. {o}")
        a = input("输入数字（回车跳过）：").strip()
        return opts[int(a) - 1] if a.isdigit() and 1 <= int(a) <= len(opts) else "跳过"
    print()
    print("=" * 60)
    print("浏览页已在浏览器打开。看完后回答下面几个问题（直接回车可跳过）。")
    print("=" * 60)
    ans = {}
    ans["图片都正常显示，颜色和方向与 Eagle 一致"] = yn("1. 图片都正常显示、颜色和方向与 Eagle 里一样吗？")
    if ans["图片都正常显示，颜色和方向与 Eagle 一致"] == "否":
        ans["图片显示问题说明"] = input("   哪里不对？简单描述：").strip()
    if has_real_comments:
        ans["区域评论的框位置正确"] = yn("2. 粉色框（区域评论）的位置和你在 Eagle 里画的一致吗？")
        if ans["区域评论的框位置正确"] == "否":
            ans["区域评论问题说明"] = input("   偏到哪里了？（例如：整体偏右、旋转了 90 度、只有某张图不对）：").strip()
    ans["参考组局部画面正确"] = yn("3. 参考组里截取的局部画面正常吗？")
    ans["备份目标"] = choose("4. 以后 Kinshoko 的备份你打算放在哪？", ["电脑里另一块硬盘", "U 盘或移动硬盘", "网盘同步文件夹（如 OneDrive、百度网盘同步盘）", "还没想好"])
    ans["备份频率"] = choose("5. 你希望多久备份一次？", ["每天自动", "每周自动", "每月自动", "只在我手动点的时候"])
    ans["其他想说的"] = input("6. 还有什么想说的？（直接回车跳过）：").strip()
    return ans


def write_report(W, answers, error=None):
    R = os.path.join(W, "报告")
    os.makedirs(R, exist_ok=True)
    passed = sum(1 for g in gates if g[2] is True)
    failed = sum(1 for g in gates if g[2] is False)
    skipped = sum(1 for g in gates if g[2] is None)
    out = ["# #8 真实 Eagle 往返检查结果", "",
           f"生成于 {ks.now()}；{passed} 项通过，{failed} 项未通过，{skipped} 项未覆盖。样本取自画师电脑上 Eagle 真实写出的资料库。", ""]
    if error:
        out += ["## ⚠️ 运行中断", "", "```", error, "```", ""]
    out += ["## 门槛", "", "| 方面 | 检查 | 结果 |", "|---|---|---|"]
    out += [f"| {a} | {n}{('（' + d + '）') if d else ''} | {'✅' if ok else ('❌' if ok is False else '⏭ 未覆盖')} |" for a, n, ok, d in gates]
    out += ["", "## 在副本上合成的部分", ""] + ([f"- {s}" for s in synthesized] or ["- 无"])
    out += ["", "## 需要注意", ""] + ([f"- {s}" for s in notes] or ["- 无"])
    out += ["", "## 字段保留清单（真实数据）", "", "| 字段 | 导入后取回（条目） | 备份恢复后一致 |", "|---|---|---|"]
    out += [f"| {a} | {b} | {'✅' if c else '❌'} |" for a, b, c in field_rows]
    out += ["", "## 画师回答", ""] + ([f"- {k}：{v}" for k, v in answers.items()] or ["- （未回答）"])
    out += ["", "## 只记录", "", "```json", json.dumps({"硬件": hardware(), **metrics}, ensure_ascii=False, indent=2), "```"]
    out += ["", "## 场景记录", ""] + log
    text = scrub("\n".join(out) + "\n")
    open(os.path.join(R, "report.md"), "w", encoding="utf-8").write(text)
    summary = {"tool_version": TOOL_VERSION, "passed": passed, "failed": failed, "skipped": skipped,
               "gates": [{"area": a, "name": n, "ok": ok, "detail": d} for a, n, ok, d in gates],
               "synthesized": synthesized, "notes": notes, "answers": answers, "hardware": hardware(), "metrics": metrics, "error": error}
    open(os.path.join(R, "summary.json"), "w", encoding="utf-8").write(scrub(json.dumps(summary, ensure_ascii=False, indent=2)))
    zpath = os.path.join(EXE_DIR, f"kinshoko-eagle-check-报告-{time.strftime('%Y%m%d-%H%M')}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in ("report.md", "summary.json"):
            z.write(os.path.join(R, f), f)
    return zpath, passed, failed


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child_main(sys.argv[2], sys.argv[3])
        return
    ap = argparse.ArgumentParser(description="Kinshoko #8：真实 Eagle 资料库往返检查")
    ap.add_argument("library", nargs="*", help="Eagle 资料库文件夹（可省略，自动查找；也可以把文件夹拖到 exe 上）")
    ap.add_argument("--count", type=int, default=300, help="样本张数上限（默认 300）")
    ap.add_argument("--budget-mb", type=int, default=1024, help="样本原文件总大小上限（MB，默认 1024）")
    ap.add_argument("--scan-cap", type=int, default=20000, help="最多读取多少条元数据用于挑样本")
    ap.add_argument("--work", help="工作区位置（默认 exe 旁边）")
    ap.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    ap.add_argument("--yes", action="store_true", help="不询问，全部用默认值")
    ap.add_argument("--no-questions", action="store_true", help="跳过最后的问题")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览页和报告位置")
    args = ap.parse_args()
    W = workspace(args.work)
    print("Kinshoko Eagle 往返检查：只读你的 Eagle 资料库，在副本上测试，大约需要几分钟。\n", flush=True)
    error, answers, D2 = None, {}, None
    try:
        W, D2 = run(args)
    except SystemExit as e:
        if e.code not in (None, 0):
            error = str(e.code)
            print("\n" + error)
    except Exception:
        error = scrub(traceback.format_exc())
        print("\n程序出错了，错误信息会写进报告：\n" + error)
    if D2 and not args.no_open:
        webbrowser.open(os.path.join(D2, "browse.html"))
    if D2 and not args.no_questions and not args.yes:
        try:
            answers = ask_questions(bool(metrics.get("真实区域评论")))
        except EOFError:
            pass
    zpath, passed, failed = write_report(W, answers, error)
    print()
    print("=" * 60)
    if error:
        print(f"检查中途停止（已完成 {passed} 项通过、{failed} 项未通过）。出错信息已写进报告。")
    else:
        print(f"完成：{passed} 项通过，{failed} 项未通过。")
    print(f"请把这个文件发回：{zpath}")
    print("（里面只有检查结果和计数，没有图片、文件名、标签和备注。）")
    print(f"工作区 {W} 只是副本，发回报告后可以整个删除。")
    print("=" * 60)
    if not args.no_open and os.name == "nt":
        subprocess.run(["explorer", "/select,", zpath])
    if not args.yes:
        try:
            input("按回车键关闭窗口……")
        except EOFError:
            pass
    sys.exit(0 if not error and failed == 0 else 1)


if __name__ == "__main__":
    main()
