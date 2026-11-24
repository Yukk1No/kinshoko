"""内置翻译表生成脚本的测试。运行：python -m unittest（在本目录下）。"""

import hashlib
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import translation_table as tt

HEADER = "\t".join(tt.COLUMNS) + "\n"


def tsv(*rows):
    return HEADER + "".join("\t".join(r) + "\n" for r in rows)


VOCAB_ROWS = [
    ("1girl", "0"),
    ("blue_eyes", "0"),
    ("hatsune_miku", "4"),
    ("2021", "0"),
    ("long_hair", "0"),
    ("highres", "5"),
    ("bkub", "1"),
    ("rating:s", "9"),
    ("bow", "0"),
]


class SelectCandidates(unittest.TestCase):
    def test_only_general_tags_in_vocabulary_order_up_to_the_limit(self):
        got = tt.select_candidates(VOCAB_ROWS, limit=3)
        self.assertEqual(got, ["1girl", "blue_eyes", "long_hair"])

    def test_years_are_never_candidates(self):
        got = tt.select_candidates(VOCAB_ROWS, limit=10)
        self.assertNotIn("2021", got)
        self.assertEqual(got, ["1girl", "blue_eyes", "long_hair", "bow"])


class ParseTranslations(unittest.TestCase):
    def test_reads_names_aliases_and_review_notes(self):
        got = tt.parse_translations(tsv(
            ("blue_eyes", "蓝瞳", "蓝眼睛|蓝眼", ""),
            ("long_hair", "长发", "", "改：长头发 → 长发，画师常说长发"),
            ("bow", "", "", "弃：蝴蝶结与弓多义"),
        ))
        self.assertEqual(got["blue_eyes"], tt.Row("蓝瞳", ("蓝眼睛", "蓝眼"), ""))
        self.assertEqual(got["long_hair"].review, "改：长头发 → 长发，画师常说长发")
        self.assertTrue(got["bow"].dropped)

    def test_trailing_empty_columns_may_be_left_out(self):
        got = tt.parse_translations(HEADER + "solo\t单人\nsmile\t微笑\t笑\n")
        self.assertEqual(got["solo"], tt.Row("单人", (), ""))
        self.assertEqual(got["smile"].aliases, ("笑",))
        with self.assertRaises(tt.TranslationError):
            tt.parse_translations(HEADER + "solo\n")

    def test_rejects_rows_that_are_incomplete_or_inconsistent(self):
        bad = [
            ("blue_eyes", "", "", ""),                 # 没有名称也没有弃用理由
            ("blue_eyes", "蓝瞳", "", "弃：多义"),      # 弃用了却还有名称
            ("blue_eyes", "", "", "弃："),             # 弃用没有理由
            ("blue_eyes", "蓝瞳", "蓝瞳", ""),          # 别名与名称相同
            ("blue_eyes", "蓝瞳", "蓝眼|蓝眼", ""),     # 别名重复
            ("blue_eyes", "蓝瞳", "", "随便写"),         # 审核栏只能空、改：或弃：
        ]
        for row in bad:
            with self.subTest(row=row), self.assertRaises(tt.TranslationError):
                tt.parse_translations(tsv(row))
        with self.assertRaises(tt.TranslationError):
            tt.parse_translations(tsv(("blue_eyes", "蓝瞳", "", ""), ("blue_eyes", "蓝眼", "", "")))
        with self.assertRaises(tt.TranslationError):
            tt.parse_translations("external\tname\n")


SOURCE = tt.VocabularySource("PixAI test", "https://example.invalid/selected_tags.csv", "0" * 64)


class BuildTable(unittest.TestCase):
    CANDIDATES = ["1girl", "blue_eyes", "long_hair", "bow"]
    ROWS = tsv(
        ("1girl", "1个女孩", "单个女孩", ""),
        ("blue_eyes", "蓝瞳", "蓝眼睛", ""),
        ("long_hair", "长发", "", ""),
        ("bow", "", "", "弃：蝴蝶结与弓多义"),
    )

    def build(self, rows=None, previous=None, candidates=None):
        return tt.build_table(
            candidates or self.CANDIDATES, tt.parse_translations(rows or self.ROWS), SOURCE, previous
        )

    def test_kept_rows_become_zh_cn_entries_sorted_by_external_name(self):
        table = self.build()
        self.assertEqual(table["format"], "kinshoko.builtin-translation-table")
        self.assertEqual(table["table_version"], 1)
        self.assertEqual([e["external"] for e in table["entries"]], ["1girl", "blue_eyes", "long_hair"])
        self.assertEqual(
            table["entries"][1],
            {"external": "blue_eyes", "names": {"zh-CN": "蓝瞳"},
             "aliases": [{"name": "蓝眼睛", "lang": "zh-CN"}]},
        )
        self.assertEqual(table["entries"][2]["aliases"], [])

    def test_every_candidate_needs_a_row_and_every_row_a_candidate(self):
        with self.assertRaises(tt.TranslationError):
            self.build(candidates=self.CANDIDATES + ["smile"])
        with self.assertRaises(tt.TranslationError):
            self.build(candidates=["1girl", "blue_eyes", "long_hair"])

    def test_a_name_or_alias_may_belong_to_only_one_entry(self):
        clashes = [
            tsv(("1girl", "长发", "", ""), ("blue_eyes", "蓝瞳", "", ""), ("long_hair", "长发", "", ""),
                ("bow", "", "", "弃：多义")),
            tsv(("1girl", "1个女孩", "蓝眼", ""), ("blue_eyes", "蓝瞳", "蓝眼", ""), ("long_hair", "长发", "", ""),
                ("bow", "", "", "弃：多义")),
            tsv(("1girl", "1个女孩", "蓝瞳", ""), ("blue_eyes", "蓝瞳", "", ""), ("long_hair", "长发", "", ""),
                ("bow", "", "", "弃：多义")),
        ]
        for rows in clashes:
            with self.subTest(rows=rows), self.assertRaises(tt.TranslationError):
                self.build(rows)

    def test_version_stays_for_same_content_and_goes_up_when_it_changes(self):
        first = tt.render_table(self.build())
        self.assertEqual(self.build(previous=first)["table_version"], 1)
        changed = self.ROWS.replace("长发\t\t", "长发\t长头发\t")
        self.assertEqual(self.build(changed, previous=first)["table_version"], 2)

    def test_rendering_is_stable_json_with_one_entry_per_line(self):
        text = tt.render_table(self.build())
        self.assertEqual(json.loads(text), self.build())
        self.assertIn('    {"external": "blue_eyes", "names": {"zh-CN": "蓝瞳"}', text)
        self.assertTrue(text.endswith("}\n"))


class ReviewSample(unittest.TestCase):
    def test_sample_holds_every_correction_and_drop_plus_every_nth_unchanged_entry(self):
        candidates = [f"tag_{i}" for i in range(10)] + ["fixed", "gone"]
        rows = tsv(
            *[(f"tag_{i}", f"标签{i}", "", "") for i in range(10)],
            ("fixed", "改后", "", "改：原名 → 改后，原名不通"),
            ("gone", "", "", "弃：多义"),
        )
        text = tt.render_review(candidates, tt.parse_translations(rows), every=4)
        lines = [ln for ln in text.splitlines() if not ln.startswith("#")]
        self.assertEqual(lines[0].split("\t"), tt.REVIEW_COLUMNS)
        externals = [ln.split("\t")[1] for ln in lines[1:]]
        self.assertEqual(externals, ["tag_0", "tag_4", "tag_8", "fixed", "gone"])
        self.assertEqual(lines[1].split("\t")[0], "1")


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        vocab = "tag_id,name,category,count\n0,1girl,0,0\n1,blue_eyes,0,0\n2,hatsune_miku,4,0\n"
        self.vocab = os.path.join(self.dir.name, "selected_tags.csv")
        with open(self.vocab, "w", encoding="utf-8", newline="") as f:
            f.write(vocab)
        self.sha = hashlib.sha256(vocab.encode()).hexdigest()
        self.rows = os.path.join(self.dir.name, "translations.tsv")
        self.out = os.path.join(self.dir.name, "table.json")
        self.review = os.path.join(self.dir.name, "review.tsv")

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = tt.main([*args, "--vocab", self.vocab, "--vocab-sha256", self.sha, "--limit", "10",
                            "--translations", self.rows, "--out", self.out, "--review", self.review])
        return code, out.getvalue(), err.getvalue()

    def test_pending_lists_untranslated_candidates_then_build_and_check_agree(self):
        with open(self.rows, "w", encoding="utf-8", newline="") as f:
            f.write(tsv(("1girl", "1个女孩", "", "")))
        code, out, _ = self.run_cli("pending")
        self.assertEqual((code, out), (0, "blue_eyes\n"))
        self.assertEqual(self.run_cli("build")[0], 1)
        with open(self.rows, "a", encoding="utf-8", newline="") as f:
            f.write("blue_eyes\t蓝瞳\t蓝眼睛\t\n")
        self.assertEqual(self.run_cli("build")[0], 0)
        self.assertEqual(self.run_cli("check")[0], 0)
        with open(self.out, encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["entries"]), 2)
        with open(self.review, "a", encoding="utf-8") as f:
            f.write("stale\n")
        self.assertEqual(self.run_cli("check")[0], 1)

    def test_a_vocabulary_with_another_hash_is_refused(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = tt.main(["pending", "--vocab", self.vocab, "--vocab-sha256", "1" * 64,
                            "--translations", self.rows])
        self.assertEqual(code, 1)
        self.assertIn("哈希不符", err.getvalue())


if __name__ == "__main__":
    unittest.main()
