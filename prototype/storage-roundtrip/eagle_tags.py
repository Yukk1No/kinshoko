"""PROTOTYPE — 导出画师 Eagle 库的全部标签，用来确定导入向导“补外部对应”的规模（#9 Q19）。

双击运行（打包后的 exe）：
  1. 用 eagle_check 的同一套办法找到 Eagle 资料库，只读。
  2. 读全部条目的 metadata.json，统计每个标签的使用次数（回收站里的图单独计数）。
  3. 下载 PixAI v1.0 词表（与 tagger-probe 同一固定版本），标出每个标签能否精确或规范化后对上外部名称。
  4. 在桌面写出 kinshoko-eagle-tags-*.zip：tags.csv、tag-groups.json、summary.md。

与 eagle_check 不同，这份报告**含标签名本身**；发起者已征得画师同意。不含文件名、备注、链接、路径和图片。

开发时：python eagle_tags.py --library <某个.library> --yes --out <目录>
"""
import argparse, csv, io, json, os, sys, time, unicodedata, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eagle_check import discover, read_json  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

TOOL_VERSION = "2026-10-06"
# 与 tools/tagger-probe/src/models.rs 的 V1_REPO／V1_REVISION 相同
PIXAI_TAGS_URL = ("https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/resolve/"
                  "0800778563144a0e6fdf41ddadd84aae3cb0dbcf/selected_tags.csv")


def script_of(tag):
    """粗分写法：danbooru 式英文、其他拉丁、中文、日文假名、混合。"""
    kinds = set()
    for ch in tag:
        if ch.isspace() or ch in "_-()'.:!?&/+~,":
            continue
        if ch.isascii():
            kinds.add("latin")
            continue
        name = unicodedata.name(ch, "")
        if "HIRAGANA" in name or "KATAKANA" in name:
            kinds.add("kana")
        elif "CJK" in name:
            kinds.add("cjk")
        elif "LATIN" in name or "FULLWIDTH" in name:
            kinds.add("latin")
        else:
            kinds.add("other")
    if kinds == {"latin"}:
        return "英文下划线" if "_" in tag and tag == tag.lower() and " " not in tag else "英文其他"
    if kinds == {"cjk"}:
        return "中文或日文汉字"
    if kinds and kinds <= {"cjk", "kana"}:
        return "日文"
    return "混合或其他" if kinds else "空"


def normalize(tag):
    return unicodedata.normalize("NFKC", tag).strip().lower().replace(" ", "_")


def load_pixai(path_override):
    try:
        if path_override:
            text = open(path_override, encoding="utf-8").read()
        else:
            with urllib.request.urlopen(PIXAI_TAGS_URL, timeout=60) as r:
                text = r.read().decode("utf-8")
    except Exception as e:  # 没网时照样导出，只是不做对照
        return None, f"{type(e).__name__}"
    rows = list(csv.DictReader(io.StringIO(text)))
    return {r["name"]: r.get("category", "") for r in rows if r.get("name")}, None


def collect(lib):
    img_dir = os.path.join(lib, "images")
    counts, trash_counts, unreadable, n = {}, {}, 0, 0
    dirs = [d for d in os.listdir(img_dir) if d.endswith(".info")]
    for i, d in enumerate(dirs):
        if i and i % 2000 == 0:
            print(f"  已读 {i}/{len(dirs)} 条……", flush=True)
        try:
            m = read_json(os.path.join(img_dir, d, "metadata.json"))
        except (OSError, ValueError):
            unreadable += 1
            continue
        n += 1
        target = trash_counts if m.get("isDeleted") else counts
        for t in m.get("tags") or []:
            if isinstance(t, str):
                target[t] = target.get(t, 0) + 1
    return counts, trash_counts, n, unreadable


def main():
    ap = argparse.ArgumentParser(description="导出 Eagle 资料库的标签与使用次数")
    ap.add_argument("library", nargs="*", help="资料库文件夹（.library）；不填则自动找")
    ap.add_argument("--library", dest="library_opt", action="append", default=[])
    ap.add_argument("--yes", action="store_true", help="不提问；自动找到多个库时只导出最大的")
    ap.add_argument("--out", help="zip 输出目录，默认桌面")
    ap.add_argument("--pixai-tags", help="本地 selected_tags.csv（离线或测试用）")
    args = ap.parse_args()

    explicit = args.library + args.library_opt
    libs, _ = discover(explicit)
    if not libs:
        raise SystemExit("没有找到 Eagle 资料库。可以把资料库文件夹（以 .library 结尾）拖到本程序图标上再运行。")
    for i, l in enumerate(libs):
        print(f"  [{i + 1}] {l['path']} —— {l['items']} 项，Eagle {l['version']}")
    picks = list(range(len(libs)))
    if len(libs) > 1 and args.yes and not explicit:
        picks = [0]  # discover 自动找到的库已按条目数从多到少排好
    elif len(libs) > 1 and not args.yes:
        ans = input("导出哪些库？直接回车＝全部，或输入编号（如 1 或 1,2）：").strip()
        if ans:
            picks = [int(x) - 1 for x in ans.replace("，", ",").split(",") if x.strip().isdigit() and 0 < int(x) <= len(libs)] or picks

    print("正在下载 PixAI 词表用于对照……", flush=True)
    pixai, pixai_err = load_pixai(args.pixai_tags)
    pixai_norm = {normalize(k): k for k in pixai} if pixai else {}

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = args.out or os.path.join(os.path.expanduser("~"), "Desktop")
    os.makedirs(out_dir, exist_ok=True)
    zpath = os.path.join(out_dir, f"kinshoko-eagle-tags-{stamp}.zip")
    summary = [f"# Eagle 标签导出（#9 Q19）", "", f"工具版本 {TOOL_VERSION}；导出于 {time.strftime('%Y-%m-%d %H:%M')}。", ""]
    if pixai_err:
        summary += [f"PixAI 词表下载失败（{pixai_err}），没有做对照。", ""]

    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for k, idx in enumerate(picks, 1):
            lib = libs[idx]["path"]
            print(f"读取资料库 {k}……", flush=True)
            counts, trash, n, unreadable = collect(lib)
            names = sorted(set(counts) | set(trash), key=lambda t: (-counts.get(t, 0), t))
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["tag", "count", "count_in_trash", "script", "pixai_exact", "pixai_normalized", "pixai_category"])
            by_script, exact_n, norm_n, exact_uses, norm_uses, total_uses = {}, 0, 0, 0, 0, 0
            for t in names:
                c = counts.get(t, 0)
                s = script_of(t)
                ex = bool(pixai) and t in pixai
                nm = pixai_norm.get(normalize(t)) if pixai and not ex else None
                cat = pixai.get(t if ex else nm, "") if pixai and (ex or nm) else ""
                w.writerow([t, c, trash.get(t, 0), s, int(ex), nm or "", cat])
                by_script[s] = by_script.get(s, 0) + 1
                total_uses += c
                if ex:
                    exact_n += 1; exact_uses += c
                elif nm:
                    norm_n += 1; norm_uses += c
            z.writestr(f"library{k}/tags.csv", "﻿" + buf.getvalue())
            try:
                groups = read_json(os.path.join(lib, "metadata.json")).get("tagsGroups") or []
            except (OSError, ValueError):
                groups = []
            z.writestr(f"library{k}/tag-groups.json", json.dumps(
                [{"name": g.get("name"), "tags": g.get("tags") or []} for g in groups], ensure_ascii=False, indent=2))
            pct = lambda a, b: f"{100 * a / b:.1f}%" if b else "—"
            summary += [f"## 资料库 {k}（Eagle {libs[idx]['version']}）", "",
                        f"- 条目 {n}，无法读取 {unreadable}；不同标签 {len(names)}，其中只出现在回收站的 {len(set(trash) - set(counts))}。",
                        "- 写法：" + "，".join(f"{s} {v}" for s, v in sorted(by_script.items(), key=lambda x: -x[1])) + "。"]
            if pixai:
                summary += [f"- PixAI 词表：精确对上 {exact_n} 个标签（占使用次数 {pct(exact_uses, total_uses)}），"
                            f"规范化（大小写、空格、全角）后再对上 {norm_n} 个（{pct(norm_uses, total_uses)}），"
                            f"其余 {len(names) - exact_n - norm_n} 个对不上。"]
            summary.append(f"- 标签组 {len(groups)} 个。")
            summary.append("")
        z.writestr("summary.md", "\n".join(summary))

    print()
    print("\n".join(summary))
    print("=" * 60)
    print(f"请把这个文件发回：{zpath}")
    print("（里面有标签名和使用次数，没有图片、文件名、备注和路径。）")
    print("=" * 60)
    if not args.yes:
        if os.name == "nt":
            os.system(f'explorer /select,"{zpath}"')
        try:
            input("按回车键关闭窗口……")
        except EOFError:
            pass


if __name__ == "__main__":
    main()
