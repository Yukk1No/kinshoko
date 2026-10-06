"""生成内置近似对应表。

离线脚本：从固定版本的 PixAI v1.0 词表生成相近候选，与 LLM agent 的审核记录合并，
只把审核接受的候选写进数据文件。只用 Python 标准库。用法见同目录 README.md。
"""

from __future__ import annotations

import math
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
