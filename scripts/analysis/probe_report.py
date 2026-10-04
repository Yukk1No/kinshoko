"""Summarise a tagger-probe predictions.jsonl against the acceptance contract.

Usage: python scripts/analysis/probe_report.py <predictions.jsonl | report.zip> [--split evaluation|calibration|all]

- Rating gate: positives are samples with pixiv's R-18 flag, except pages reviewed as only
  suggestive (coverage "r18-page-borderline"; the flag covers the whole work). Two rules are reported:
  "top" (the highest rating class is questionable or explicit, as in acceptance.md) and
  "threshold" (questionable or explicit score >= RATING_THRESHOLD, PixAI v1.0's
  recommended rating threshold; its rating outputs are independent sigmoids).
- Tag report: pixiv author tags are weak labels, so only author-tag recall is a rate;
  model positives without the author tag are counted, not called errors.
"""
import argparse, collections, io, json, os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Read from the manifest too, so reports made before a page was reviewed are judged the same way.
BORDERLINE_IDS = {
    s["id"]
    for s in json.load(open(os.path.join(ROOT, "docs/validation/sample-manifest.pixiv-r18.json"), encoding="utf-8"))["samples"]
    if "r18-page-borderline" in s["coverage"]
}

# pixiv author tag -> Danbooru tags that count as a hit
TAG_MAP = {
    "青髪": ["blue_hair", "aqua_hair"], "水色髪": ["light_blue_hair", "blue_hair", "aqua_hair"],
    "金髪": ["blonde_hair"], "黒髪": ["black_hair"], "銀髪": ["grey_hair", "white_hair"],
    "白髪": ["white_hair", "grey_hair"], "赤髪": ["red_hair"], "ピンク髪": ["pink_hair"],
    "茶髪": ["brown_hair"], "緑髪": ["green_hair"], "紫髪": ["purple_hair"],
    "ショートヘア": ["short_hair"], "ロングヘア": ["long_hair", "very_long_hair"], "ボブ": ["bob_cut"],
    "ツインテール": ["twintails"], "ポニーテール": ["ponytail"],
    "ぱっつん": ["blunt_bangs"], "前髪ぱっつん": ["blunt_bangs"], "姫カット": ["hime_cut"],
    "センター分け": ["middle_part", "parted_bangs"], "センターパート": ["middle_part", "parted_bangs"],
    "モノクロ": ["monochrome", "greyscale"], "白黒": ["monochrome", "greyscale"], "線画": ["lineart"],
    "逆光": ["backlighting"], "全身": ["full_body"], "バストアップ": ["upper_body", "portrait"],
}
EXACT_WANTED = {"センター分け": "middle_part", "センターパート": "middle_part"}
RATING_THRESHOLD = 0.41
RATING_NAMES = {"rating:g": "general", "rating:s": "sensitive", "rating:q": "questionable", "rating:e": "explicit"}


def load(path):
    if path.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            text = z.read("predictions.jsonl").decode("utf-8")
    else:
        text = open(path, encoding="utf-8").read()
    return [json.loads(l) for l in text.splitlines() if l.strip()]


def qe(r):
    return max(r["ratings"].get("questionable", 0), r["ratings"].get("explicit", 0))


RULES = {
    "最高档": lambda r: max(r["ratings"], key=r["ratings"].get) in ("questionable", "explicit"),
    f"q/e ≥ {RATING_THRESHOLD}": lambda r: qe(r) >= RATING_THRESHOLD,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("predictions")
    ap.add_argument("--split", default="evaluation", choices=["evaluation", "calibration", "all"])
    a = ap.parse_args()
    rows = [r for r in load(a.predictions) if a.split == "all" or r["split"] == a.split]
    for r in rows:
        if r["sample"] in BORDERLINE_IDS and "r18-page-borderline" not in r["coverage"]:
            r["coverage"] = r["coverage"] + ["r18-page-borderline"]
        if r.get("ratings"):
            r["ratings"] = {RATING_NAMES.get(k, k): v for k, v in r["ratings"].items()}
    out = io.StringIO()
    w = lambda s="": print(s, file=out)
    w(f"# 打标探测分析（split={a.split}）\n")

    by_model = collections.defaultdict(list)
    for r in rows:
        by_model[r["model"]].append(r)

    for model, rs in by_model.items():
        w(f"## {model}（{len(rs)} 张，{rs[0]['provider']}）\n")
        rated = [r for r in rs if r.get("ratings")]
        w("### 内容分级\n")
        if not rated:
            w("- 该模型不输出分级。\n")
        else:
            pos = [r for r in rated if r["truth_rating"] == "r18" and "r18-page-borderline" not in r["coverage"]]
            border = [r for r in rated if "r18-page-borderline" in r["coverage"]]
            neg = [r for r in rated if r["truth_rating"] != "r18"]
            sens = [r for r in neg if "sensitive" in r["coverage"]]
            plain = [r for r in neg if "sensitive" not in r["coverage"]]
            for rule, flagged in RULES.items():
                caught = sum(flagged(r) for r in pos)
                rate = f"（{caught / len(pos):.1%}，门槛 ≥ 95%）" if pos else "（没有 R-18 样本）"
                w(f"- 规则「{rule}」R-18 召回：{caught}/{len(pos)}{rate}")
                for r in pos:
                    if not flagged(r):
                        scores = "，".join(f"{k} {v:.2f}" for k, v in sorted(r["ratings"].items(), key=lambda kv: -kv[1]))
                        w(f"  - 漏判 {r['sample']}：{scores}")
                if border:
                    w(f"  - 复核为擦边的 R-18 页被判 q/e：{sum(flagged(r) for r in border)}/{len(border)}（不计入门槛）")
                if sens:
                    w(f"  - 敏感全年龄被判 q/e：{sum(flagged(r) for r in sens)}/{len(sens)}（只记录）")
                if plain:
                    w(f"  - 其他全年龄被判 q/e：{sum(flagged(r) for r in plain)}/{len(plain)}（只记录）")
            w()

        w("### 与 pixiv 作者标签对照（只记录）\n")
        w("| 作者标签 | 对应标签 | 作者标了 | 模型命中 | 命中率 | 模型给出但作者未标 |")
        w("|---|---|---|---|---|---|")
        for jp, targets in TAG_MAP.items():
            tagged = [r for r in rs if jp in r["author_tags"]]
            if not tagged:
                continue
            hit = sum(any(t in r["tags"] for t in targets) for r in tagged)
            extra = sum(any(t in r["tags"] for t in targets) for r in rs if jp not in r["author_tags"])
            w(f"| {jp} | {', '.join(targets)} | {len(tagged)} | {hit} | {hit / len(tagged):.0%} | {extra} |")
        for jp, exact in EXACT_WANTED.items():
            tagged = [r for r in rs if jp in r["author_tags"]]
            if tagged:
                w(f"\n精确 `{exact}`：{sum(exact in r['tags'] for r in tagged)}/{len(tagged)}（{jp}）")
        w()
    sys.stdout.write(out.getvalue())


if __name__ == "__main__":
    main()
