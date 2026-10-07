"""生成内置翻译表。

离线脚本：从固定版本的 PixAI v1.0 词表按出现频率选出最常用的一般标签，与 LLM agent
翻译并审核过的译名合并，写成随软件分发的翻译表，另抽出一份审核样本给维护者抽查。
只用 Python 标准库。用法见同目录 README.md。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass

# ---------------------------------------------------------------- 候选

# 词表中一般标签的类别；角色（4）、作品（3）、作者（1）、元数据（5）、分级（9）不进翻译表。
GENERAL_CATEGORY = "0"
# 选多少个一般标签。
DEFAULT_LIMIT = 3000
# 纯数字（年份等）不是画师会找的内容。
_NUMERIC = re.compile(r"^\d+$")


def select_candidates(rows, limit=DEFAULT_LIMIT):
    """按词表顺序取前 limit 个一般标签。

    rows 是词表中 (name, category) 的序列，保持文件顺序。PixAI 沿用 WD tagger 的
    selected_tags.csv 格式：同一类别内按 Danbooru 投稿数从多到少排列（本修订的 count
    列全是 0），所以文件顺序就是频率顺序。
    """
    out = []
    for name, category in rows:
        if category != GENERAL_CATEGORY or _NUMERIC.match(name):
            continue
        out.append(name)
        if len(out) == limit:
            break
    return out


# ---------------------------------------------------------------- 译名

COLUMNS = ["external", "name", "aliases", "review"]
LANG = "zh-CN"
ALIAS_SEP = "|"
CORRECTED = "改："
DROPPED = "弃："


class TranslationError(Exception):
    """译名记录不完整、互相冲突，或与候选对不上。"""


@dataclass(frozen=True)
class Row:
    """一个外部名称的译名与审核结论。"""

    name: str
    aliases: tuple
    review: str

    @property
    def dropped(self):
        return self.review.startswith(DROPPED)

    @property
    def corrected(self):
        return self.review.startswith(CORRECTED)


def parse_translations(text):
    """读取译名记录（TSV）：external、name、aliases（以 | 分隔）、review。

    review 为空表示审核通过、未改动；以“改：”开头表示审核改过译名（写明原译与理由）；
    以“弃：”开头表示审核弃用（多义或拿不准），这时名称和别名必须为空。
    """
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines or lines[0].split("\t") != COLUMNS:
        raise TranslationError("译名记录缺少表头：" + "\t".join(COLUMNS))
    out = {}
    for n, line in enumerate(lines[1:], start=2):
        cols = line.split("\t")
        if not 2 <= len(cols) <= len(COLUMNS):
            raise TranslationError(f"第 {n} 条记录应有 2 到 {len(COLUMNS)} 列：{line}")
        # 末尾的空列可以省略（编辑器常会删掉行尾的制表符）。
        cols += [""] * (len(COLUMNS) - len(cols))
        external, name, aliases, review = (c.strip() for c in cols)
        aliases = tuple(a.strip() for a in aliases.split(ALIAS_SEP) if a.strip())
        row = Row(name, aliases, review)
        if review and not (row.dropped or row.corrected):
            raise TranslationError(f"第 {n} 条记录的审核栏只能为空、以“改：”或“弃：”开头：{line}")
        if review and not review[2:].strip():
            raise TranslationError(f"第 {n} 条记录缺少审核理由：{line}")
        if row.dropped and (name or aliases):
            raise TranslationError(f"第 {n} 条记录已弃用，名称与别名应为空：{line}")
        if not row.dropped and not name:
            raise TranslationError(f"第 {n} 条记录缺少名称：{line}")
        if name in aliases or len(set(aliases)) != len(aliases):
            raise TranslationError(f"第 {n} 条记录的别名重复或与名称相同：{line}")
        if external in out:
            raise TranslationError(f"重复的译名记录：{external}")
        out[external] = row
    return out


# ---------------------------------------------------------------- 数据文件

FORMAT = "kinshoko.builtin-translation-table"
FORMAT_VERSION = 1


@dataclass(frozen=True)
class VocabularySource:
    """固定版本的外部词表。"""

    name: str
    url: str
    sha256: str


def _listing(title, items, limit=20):
    rows = list(items[:limit])
    if len(items) > limit:
        rows.append(f"……共 {len(items)} 条")
    return f"{title}：\n" + "\n".join(rows)


def build_table(candidates, rows, source, previous):
    """把审核通过的译名写成数据文件内容。

    每个候选都要有译名记录，译名记录也都要对应现有候选。一个文字只能是一个条目的名称或
    别名：否则画师输入它时对不上唯一的标签。previous 是现有数据文件的文本（没有时为
    None）：内容不变则沿用其表版本，内容变化则表版本加一。
    """
    missing = [c for c in candidates if c not in rows]
    stale = sorted(rows.keys() - set(candidates))
    problems = []
    if missing:
        problems.append(_listing("以下候选还没有译名（可用 pending 列出全部）", missing))
    if stale:
        problems.append(_listing("以下译名记录已不是候选", stale))

    owners = {}
    for external in sorted(rows):
        row = rows[external]
        for text in (row.name, *row.aliases) if not row.dropped else ():
            owners.setdefault(text, []).append(external)
    clashes = [f"{text}：{'、'.join(ex)}" for text, ex in sorted(owners.items()) if len(ex) > 1]
    if clashes:
        problems.append(_listing("以下文字同时是多个条目的名称或别名", clashes))
    if problems:
        raise TranslationError("\n".join(problems))

    entries = [
        {
            "external": external,
            "names": {LANG: rows[external].name},
            "aliases": [{"name": a, "lang": LANG} for a in rows[external].aliases],
        }
        for external in sorted(rows)
        if not rows[external].dropped
    ]
    content = {
        "vocabulary": {"name": source.name, "url": source.url, "sha256": source.sha256},
        "languages": [LANG],
        "entries": entries,
    }
    version = 1
    if previous is not None:
        old = json.loads(previous)
        old_content = {k: old.get(k) for k in content}
        version = old["table_version"] if old_content == content else old["table_version"] + 1
    return {"format": FORMAT, "format_version": FORMAT_VERSION, "table_version": version, **content}


def render_table(table):
    """稳定的 JSON 文本：每个条目占一行，方便审阅差异。"""
    head = {k: v for k, v in table.items() if k != "entries"}
    lines = ["{"]
    for k, v in head.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},")
    entries = [f"    {json.dumps(e, ensure_ascii=False)}" for e in table["entries"]]
    if entries:
        lines.append('  "entries": [')
        lines.append(",\n".join(entries))
        lines.append("  ]")
    else:
        lines.append('  "entries": []')
    lines.append("}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 审核样本

REVIEW_COLUMNS = ["rank", "external", "name", "aliases", "review"]
# 未改动的条目每隔多少个抽一个。
SAMPLE_EVERY = 25

REVIEW_HEADER = """\
# 内置翻译表审核样本（#76 Core3），由 translation_table.py build 生成，不要手改。
# 内容：审核改过的条目、弃用的条目全部列出，未改动的条目按词表频率顺序每 {every} 个抽一个。
# rank 是该标签在候选中的频率名次（1 最常见）。抽查时看译名是否是画师平常的说法、别名能否用来找到它；
# 有问题改 translations.tsv 对应行（审核栏写“改：原译 → 新译，理由”），再运行 build。
"""


def render_review(candidates, rows, every=SAMPLE_EVERY):
    """审核样本：全部改过与弃用的条目，加上未改动条目中按名次每 every 个抽一个。"""
    rank = {c: i + 1 for i, c in enumerate(candidates)}
    unchanged = [c for c in candidates if not rows[c].review]
    picked = unchanged[::every]
    picked += [c for c in candidates if rows[c].corrected]
    picked += [c for c in candidates if rows[c].dropped]
    lines = [REVIEW_HEADER.format(every=every) + "\t".join(REVIEW_COLUMNS)]
    for c in picked:
        r = rows[c]
        lines.append("\t".join([str(rank[c]), c, r.name, ALIAS_SEP.join(r.aliases), r.review]))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 词表

# 与 tools/approx-table、tools/tagger-probe 同一仓库、同一修订；
# 即 crates/kinshoko-core 中 ModelSpec.tags_sha256 固定的那份 selected_tags.csv。
PIXAI_V1 = VocabularySource(
    name="PixAI Tagger v1.0 (Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8)",
    url="https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/resolve/"
    "0800778563144a0e6fdf41ddadd84aae3cb0dbcf/selected_tags.csv",
    sha256="a9455cbf0a910d4a3890739f2f70bd986278f4594285ef1049121a03896e2a6d",
)


class VocabularyError(Exception):
    """词表文件不是固定的那个版本，或格式不对。"""


def load_vocabulary(path, sha256):
    """按文件顺序读取 selected_tags.csv 的 (name, category)，先校验文件哈希。"""
    with open(path, "rb") as f:
        data = f.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha256:
        raise VocabularyError(f"词表哈希不符：期望 {sha256}，实际 {actual}（{path}）")
    rows = csv.DictReader(io.StringIO(data.decode("utf-8")))
    if not {"name", "category"} <= set(rows.fieldnames or []):
        raise VocabularyError(f"词表缺少 name 或 category 列（{path}）")
    return [(r["name"], r["category"]) for r in rows]


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


# ---------------------------------------------------------------- 命令行

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_TRANSLATIONS = os.path.join(HERE, "translations.tsv")
DEFAULT_REVIEW = os.path.join(HERE, "review.tsv")
DEFAULT_OUT = os.path.join(REPO_ROOT, "data", "builtin-translation-table.json")
DEFAULT_CACHE = os.path.join(HERE, ".cache")


def _read(path):
    if not os.path.exists(path):
        return None
    # Git 在 Windows 上可能把换行检出为 CRLF；按 LF 比较。
    with open(path, encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def _write(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def main(argv=None):
    p = argparse.ArgumentParser(description="生成内置翻译表")
    p.add_argument("command", choices=["pending", "build", "check"],
                   help="pending：列出还没有译名的候选；build：写数据文件与审核样本；"
                        "check：确认两者都是最新的")
    p.add_argument("--vocab", help="本地 selected_tags.csv；不给则按固定修订下载到缓存")
    p.add_argument("--vocab-sha256", default=PIXAI_V1.sha256, help=argparse.SUPPRESS)
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=argparse.SUPPRESS)
    p.add_argument("--translations", default=DEFAULT_TRANSLATIONS, help="译名记录（TSV）")
    p.add_argument("--out", default=DEFAULT_OUT, help="数据文件")
    p.add_argument("--review", default=DEFAULT_REVIEW, help="审核样本（TSV）")
    args = p.parse_args(argv)

    source = VocabularySource(PIXAI_V1.name, PIXAI_V1.url, args.vocab_sha256)
    try:
        vocab_path = args.vocab or fetch_vocabulary(source, DEFAULT_CACHE)
        candidates = select_candidates(load_vocabulary(vocab_path, source.sha256), args.limit)
        rows = parse_translations(_read(args.translations) or "\t".join(COLUMNS) + "\n")
    except (VocabularyError, TranslationError, OSError) as e:
        print(e, file=sys.stderr)
        return 1

    if args.command == "pending":
        for c in candidates:
            if c not in rows:
                print(c)
        return 0

    previous = _read(args.out)
    try:
        text = render_table(build_table(candidates, rows, source, previous))
    except TranslationError as e:
        print(e, file=sys.stderr)
        return 1
    review = render_review(candidates, rows)
    if args.command == "check":
        stale = [path for path, want in ((args.out, text), (args.review, review)) if _read(path) != want]
        for path in stale:
            print(f"{path} 不是最新的，请运行 build", file=sys.stderr)
        return 1 if stale else 0
    _write(args.out, text)
    _write(args.review, review)
    table = json.loads(text)
    print(f"已写入 {args.out}：表版本 {table['table_version']}，{len(table['entries'])} 条；"
          f"审核样本 {args.review}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
