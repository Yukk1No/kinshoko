"""生成内置近似对应表。

离线脚本：从固定版本的 PixAI v1.0 词表生成相近候选，与 LLM agent 的审核记录合并，
只把审核接受的候选写进数据文件。只用 Python 标准库。用法见同目录 README.md。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import sys
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True, order=True)
class Candidate:
    """一对相近候选，按外部名称写成，a < b。"""

    category: str
    a: str
    b: str
    rule: str


# ---------------------------------------------------------------- 颜色

# 每个颜色词在动漫插画里的典型 sRGB 颜色，只用来算颜色之间的远近。
COLOR_SRGB = {
    "black": (0x22, 0x22, 0x22),
    "grey": (0x9A, 0x9A, 0xA0),
    "white": (0xF2, 0xF2, 0xF2),
    "brown": (0x7A, 0x4A, 0x2A),
    "blonde": (0xF0, 0xD0, 0x70),
    "yellow": (0xF0, 0xD0, 0x20),
    "orange": (0xF0, 0x80, 0x30),
    "red": (0xD0, 0x20, 0x20),
    "pink": (0xF0, 0xA0, 0xC0),
    "purple": (0x80, 0x50, 0xB0),
    "blue": (0x40, 0x78, 0xE0),
    "aqua": (0x40, 0xC8, 0xD8),
    "green": (0x40, 0xA0, 0x40),
}

# 每个颜色取最近的几个颜色作候选（双向取并集）。
COLOR_NEIGHBOURS = 3


def _srgb_to_lab(rgb):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


# 算颜色距离时明度的权重：插画里同一发色常有深浅变化，明度差不如色相差要紧。
LIGHTNESS_WEIGHT = 0.5
# 色度低于此值的颜色（黑、灰、白）不参与色相相邻。
ACHROMATIC_CHROMA = 10


def _pair(category, x, y, rule):
    a, b = sorted((x, y))
    return Candidate(category, a, b, rule)


def _color_pairs(category, suffix, colors, names):
    """两条规则取并集：加权色差最近的几个颜色；色环上相邻的有彩色。

    候选求全不求准，由审核把关。
    """
    present = {c: f"{c}_{suffix}" for c in colors if f"{c}_{suffix}" in names}
    lab = {c: _srgb_to_lab(COLOR_SRGB[c]) for c in present}
    out = set()

    def weighted(c):
        lightness, a, b = lab[c]
        return (lightness * LIGHTNESS_WEIGHT, a, b)

    for c in present:
        nearest = sorted((math.dist(weighted(c), weighted(o)), o) for o in present if o != c)
        for _, o in nearest[:COLOR_NEIGHBOURS]:
            out.add(_pair(category, present[c], present[o], "color-nearest"))

    hues = sorted(
        (math.degrees(math.atan2(b, a)) % 360, c)
        for c, (_, a, b) in lab.items()
        if math.hypot(a, b) >= ACHROMATIC_CHROMA
    )
    for i, (_, c) in enumerate(hues):
        if len(hues) > 1:
            o = hues[(i + 1) % len(hues)][1]
            out.add(_pair(category, present[c], present[o], "hue-adjacent"))
    return _dedupe(out)


def _dedupe(cands):
    """同一对被多条规则提出时只留一条，规则名合并。"""
    by_pair = {}
    for c in cands:
        by_pair.setdefault((c.category, c.a, c.b), set()).add(c.rule)
    return {Candidate(cat, a, b, "+".join(sorted(rules))) for (cat, a, b), rules in by_pair.items()}


HAIR_COLORS = [c for c in COLOR_SRGB if c != "yellow"]
EYE_COLORS = [c for c in COLOR_SRGB if c != "blonde"]

# 描述“不止一种颜色”的标签，组内两两成为候选，不与单色标签配对。
HAIR_COLOR_PATTERNS = [
    "multicolored_hair", "two-tone_hair", "gradient_hair", "streaked_hair",
    "split-color_hair", "colored_inner_hair", "colored_tips", "rainbow_hair",
]
EYE_COLOR_PATTERNS = [
    "multicolored_eyes", "two-tone_eyes", "gradient_eyes", "rainbow_eyes", "heterochromia",
]


def _group_pairs(category, group, names, rule):
    present = [n for n in group if n in names]
    return {_pair(category, x, y, rule) for i, x in enumerate(present) for y in present[i + 1:]}


# ---------------------------------------------------------------- 发型与刘海

# 词形归一：复数、分词形式归到同一个词。
TOKEN_FORMS = {
    "twintails": "twintail", "braids": "braid", "braided": "braid",
    "drills": "drill", "sidelocks": "sidelock", "bangs": "bang", "ringlets": "ringlet",
}
# 不区分发型的虚词；“cut”让 bob_cut 与 inverted_bob 落到同一个词 bob 上。
FILLER_TOKENS = {"hair", "with", "of", "cut"}

# 名称中出现这些词（归一后）的标签算发型；另外以 _cut 结尾的标签算发型（bob_cut 等）。
HAIRSTYLE_HEADS = {"ponytail", "twintail", "braid", "bun", "drill", "ringlet", "updo", "bob", "afro"}
# 鬓发、刘海、呆毛是头发的局部，不在发型这一类。
HAIRSTYLE_PART_TOKENS = {"sidelock", "bang", "ahoge"}
# 含发型词但不是发型的标签（食物、物品、动作、节日等）。
HAIRSTYLE_EXCLUDE = {
    "steamed_bun", "japari_bun", "bread_bun", "bun_cover", "ponytail_holder",
    "braiding_hair", "braided_beard", "drill", "drill_hand", "eyebrow_cut",
    "twintails_day", "grabbing_another's_twintails", "fake_hair_bun",
}

BANGS_HEADS = {"bang"}
BANGS_EXTRA = {"fringe_trim"}
# 刘海的颜色不是刘海形状。
BANGS_EXCLUDE = {"colored_bangs"}


def _tokens(name):
    raw = name.replace("-", "_").split("_")
    return frozenset(TOKEN_FORMS.get(t, t) for t in raw if t and t not in FILLER_TOKENS)


def _is_hairstyle(name):
    if name in HAIRSTYLE_EXCLUDE:
        return False
    toks = _tokens(name)
    named_cut = name.endswith("_cut")
    return bool((toks & HAIRSTYLE_HEADS or named_cut) and not toks & HAIRSTYLE_PART_TOKENS)


def _is_bangs(name):
    return name not in BANGS_EXCLUDE and bool(name in BANGS_EXTRA or _tokens(name) & BANGS_HEADS)


def _word_pairs(category, members, heads, siblings):
    """按名称中的词生成候选。

    - 变体与基本形：一个标签的词恰好比另一个多一个，且共享的词里有类别的核心词
      （high_ponytail / ponytail，braided_ponytail / braid）。
    - siblings=True 时另加只差一个修饰词的兄弟（blunt_bangs / parted_bangs）。
      刘海在词表里没有基本形，只能这样比较。
    """
    members = sorted(members)
    toks = {m: _tokens(m) for m in members}
    out = set()
    for i, x in enumerate(members):
        for y in members[i + 1:]:
            tx, ty = toks[x], toks[y]
            if not tx & ty & heads:
                continue
            extra = (len(tx - ty), len(ty - tx))
            if sorted(extra) == [0, 1]:
                out.add(_pair(category, x, y, "variant-of-base"))
            elif siblings and extra == (1, 1):
                out.add(_pair(category, x, y, "sibling-variants"))
    return out


def generate_candidates(names):
    """从词表名称生成四类相近候选，排序后返回。"""
    names = set(names)
    out = set()
    out |= _color_pairs("hair_color", "hair", HAIR_COLORS, names)
    out |= _group_pairs("hair_color", HAIR_COLOR_PATTERNS, names, "pattern-group")
    out |= _color_pairs("eye_color", "eyes", EYE_COLORS, names)
    out |= _group_pairs("eye_color", EYE_COLOR_PATTERNS, names, "pattern-group")
    out |= _word_pairs("hairstyle", (n for n in names if _is_hairstyle(n)), HAIRSTYLE_HEADS, siblings=False)
    out |= _word_pairs("bangs", (n for n in names if _is_bangs(n)), BANGS_HEADS, siblings=True)
    return sorted(out)


# ---------------------------------------------------------------- 审核记录

VERDICTS = {"accept", "reject"}
REVIEW_COLUMNS = ["category", "a", "b", "verdict", "reason"]


class ReviewError(Exception):
    """审核记录与候选对不上，或记录本身不完整。"""


@dataclass(frozen=True)
class Review:
    verdict: str
    reason: str


def parse_review(text):
    """读取审核记录（TSV）：category、a、b、verdict（accept/reject）、reason。"""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines or lines[0].split("\t") != REVIEW_COLUMNS:
        raise ReviewError("审核记录缺少表头：" + "\t".join(REVIEW_COLUMNS))
    out = {}
    for n, line in enumerate(lines[1:], start=2):
        cols = line.split("\t")
        if len(cols) != len(REVIEW_COLUMNS):
            raise ReviewError(f"第 {n} 条记录应有 {len(REVIEW_COLUMNS)} 列：{line}")
        category, a, b, verdict, reason = (c.strip() for c in cols)
        if verdict not in VERDICTS:
            raise ReviewError(f"第 {n} 条记录的结论只能是 accept 或 reject：{line}")
        if not reason:
            raise ReviewError(f"第 {n} 条记录缺少理由：{line}")
        a, b = sorted((a, b))
        key = (category, a, b)
        if key in out:
            raise ReviewError(f"重复的审核记录：{line}")
        out[key] = Review(verdict, reason)
    return out


# ---------------------------------------------------------------- 数据文件

FORMAT = "kinshoko.builtin-approx-table"
FORMAT_VERSION = 1
CATEGORIES = ["hair_color", "eye_color", "hairstyle", "bangs"]


@dataclass(frozen=True)
class VocabularySource:
    """固定版本的外部词表。"""

    name: str
    url: str
    sha256: str


def build_table(candidates, reviews, source, previous):
    """把审核接受的候选写成数据文件内容。

    每条候选都要有审核记录，审核记录也都要对应现有候选，否则报错。
    previous 是现有数据文件的文本（没有时为 None）：内容不变则沿用其表版本，
    内容变化则表版本加一。
    """
    keys = {(c.category, c.a, c.b) for c in candidates}
    missing = sorted(keys - reviews.keys())
    stale = sorted(reviews.keys() - keys)
    problems = []
    if missing:
        problems.append("以下候选尚未审核：\n" + "\n".join("\t".join(k) for k in missing))
    if stale:
        problems.append("以下审核记录已不是候选：\n" + "\n".join("\t".join(k) for k in stale))
    if problems:
        raise ReviewError("\n".join(problems))

    accepted = sorted(
        (CATEGORIES.index(cat), a, b, cat) for (cat, a, b) in keys if reviews[(cat, a, b)].verdict == "accept"
    )
    content = {
        "vocabulary": {"name": source.name, "url": source.url, "sha256": source.sha256},
        "categories": CATEGORIES,
        "pairs": [{"category": cat, "a": a, "b": b} for _, a, b, cat in accepted],
    }
    version = 1
    if previous is not None:
        old = json.loads(previous)
        old_content = {k: old.get(k) for k in content}
        version = old["table_version"] if old_content == content else old["table_version"] + 1
    return {"format": FORMAT, "format_version": FORMAT_VERSION, "table_version": version, **content}


# ---------------------------------------------------------------- 词表

# 与 tools/tagger-probe 测试的模型同一仓库、同一修订。
PIXAI_V1 = VocabularySource(
    name="PixAI Tagger v1.0 (Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8)",
    url="https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/resolve/"
    "0800778563144a0e6fdf41ddadd84aae3cb0dbcf/selected_tags.csv",
    sha256="a9455cbf0a910d4a3890739f2f70bd986278f4594285ef1049121a03896e2a6d",
)
# selected_tags.csv 中的一般标签类别；发色、瞳色、发型、刘海都在这一类。
GENERAL_CATEGORY = "0"


class VocabularyError(Exception):
    """词表文件不是固定的那个版本，或格式不对。"""


def load_vocabulary(path, sha256):
    """读取 selected_tags.csv 中的一般标签名称，先校验文件哈希。"""
    with open(path, "rb") as f:
        data = f.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha256:
        raise VocabularyError(f"词表哈希不符：期望 {sha256}，实际 {actual}（{path}）")
    rows = csv.DictReader(io.StringIO(data.decode("utf-8")))
    if not {"name", "category"} <= set(rows.fieldnames or []):
        raise VocabularyError(f"词表缺少 name 或 category 列（{path}）")
    return [r["name"] for r in rows if r["category"] == GENERAL_CATEGORY]


def fetch_vocabulary(source, cache_dir):
    """把词表下载到缓存目录（已有则不重复下载），返回本地路径。"""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, source.sha256 + ".csv")
    if not os.path.exists(path):
        with urllib.request.urlopen(source.url, timeout=60) as resp:
            data = resp.read()
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    return path


def render_table(table):
    """稳定的 JSON 文本：每对占一行，方便审阅差异。"""
    head = {k: v for k, v in table.items() if k != "pairs"}
    lines = ["{"]
    for k, v in head.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},")
    pairs = [f"    {json.dumps(p, ensure_ascii=False)}" for p in table["pairs"]]
    if pairs:
        lines.append('  "pairs": [')
        lines.append(",\n".join(pairs))
        lines.append("  ]")
    else:
        lines.append('  "pairs": []')
    lines.append("}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 命令行

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_REVIEW = os.path.join(HERE, "review.tsv")
DEFAULT_OUT = os.path.join(REPO_ROOT, "data", "builtin-approx-table.json")
DEFAULT_CACHE = os.path.join(HERE, ".cache")


def _read(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def main(argv=None):
    p = argparse.ArgumentParser(description="生成内置近似对应表")
    p.add_argument("command", choices=["pending", "build", "check"],
                   help="pending：列出尚未审核的候选；build：写数据文件；check：确认数据文件是最新的")
    p.add_argument("--vocab", help="本地 selected_tags.csv；不给则按固定修订下载到缓存")
    p.add_argument("--vocab-sha256", default=PIXAI_V1.sha256, help=argparse.SUPPRESS)
    p.add_argument("--review", default=DEFAULT_REVIEW, help="审核记录（TSV）")
    p.add_argument("--out", default=DEFAULT_OUT, help="数据文件")
    args = p.parse_args(argv)

    source = VocabularySource(PIXAI_V1.name, PIXAI_V1.url, args.vocab_sha256)
    try:
        vocab_path = args.vocab or fetch_vocabulary(source, DEFAULT_CACHE)
        candidates = generate_candidates(load_vocabulary(vocab_path, source.sha256))
        reviews = parse_review(_read(args.review) or "\t".join(REVIEW_COLUMNS) + "\n")
    except (VocabularyError, ReviewError, OSError) as e:
        print(e, file=sys.stderr)
        return 1

    if args.command == "pending":
        for c in candidates:
            if (c.category, c.a, c.b) not in reviews:
                # 结论与理由两列留空，由审核者填写。
                print(f"{c.category}\t{c.a}\t{c.b}\t\t")
        return 0

    previous = _read(args.out)
    try:
        text = render_table(build_table(candidates, reviews, source, previous))
    except ReviewError as e:
        print(e, file=sys.stderr)
        return 1
    if args.command == "check":
        if text != previous:
            print(f"{args.out} 不是最新的，请运行 build", file=sys.stderr)
            return 1
        return 0
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    table = json.loads(text)
    print(f"已写入 {args.out}：表版本 {table['table_version']}，{len(table['pairs'])} 对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
