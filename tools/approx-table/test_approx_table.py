"""内置近似对应表生成脚本的测试。运行：python -m unittest（在本目录下）。"""

import hashlib
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import approx_table as at


def pairs(cands, category):
    return {(c.a, c.b) for c in cands if c.category == category}


class HairColorCandidates(unittest.TestCase):
    VOCAB = [
        "black_hair", "grey_hair", "white_hair", "brown_hair", "blonde_hair",
        "orange_hair", "red_hair", "pink_hair", "purple_hair", "blue_hair",
        "aqua_hair", "green_hair", "long_hair", "blue_eyes",
    ]

    def test_neighbouring_colours_become_candidates(self):
        got = pairs(at.generate_candidates(self.VOCAB), "hair_color")
        self.assertIn(("aqua_hair", "blue_hair"), got)
        self.assertIn(("grey_hair", "white_hair"), got)

    def test_distant_colours_and_non_colour_tags_do_not(self):
        got = pairs(at.generate_candidates(self.VOCAB), "hair_color")
        self.assertNotIn(("black_hair", "blonde_hair"), got)
        self.assertNotIn(("green_hair", "pink_hair"), got)
        self.assertFalse(any("long_hair" in p for p in got))


class EyeColorCandidates(unittest.TestCase):
    VOCAB = [
        "blue_eyes", "aqua_eyes", "yellow_eyes", "orange_eyes", "red_eyes",
        "multicolored_eyes", "two-tone_eyes", "heterochromia",
        "closed_eyes", "blue_pupils", "blonde_hair",
    ]

    def test_neighbouring_eye_colours_and_mixed_colour_tags(self):
        got = pairs(at.generate_candidates(self.VOCAB), "eye_color")
        self.assertIn(("aqua_eyes", "blue_eyes"), got)
        self.assertIn(("orange_eyes", "yellow_eyes"), got)
        self.assertIn(("multicolored_eyes", "two-tone_eyes"), got)

    def test_eye_shape_and_pupil_tags_are_not_eye_colour(self):
        got = pairs(at.generate_candidates(self.VOCAB), "eye_color")
        names = {n for p in got for n in p}
        self.assertNotIn("closed_eyes", names)
        self.assertNotIn("blue_pupils", names)
        self.assertNotIn("blonde_hair", names)


class HairColorPatterns(unittest.TestCase):
    def test_multi_colour_hair_tags_pair_with_each_other_not_with_plain_colours(self):
        vocab = ["multicolored_hair", "two-tone_hair", "gradient_hair", "blue_hair"]
        got = pairs(at.generate_candidates(vocab), "hair_color")
        self.assertIn(("multicolored_hair", "two-tone_hair"), got)
        self.assertIn(("gradient_hair", "two-tone_hair"), got)
        self.assertFalse(any("blue_hair" in p for p in got))


class HairstyleCandidates(unittest.TestCase):
    VOCAB = [
        "ponytail", "high_ponytail", "low_ponytail", "braided_ponytail", "side_ponytail",
        "twintails", "low_twintails", "braid", "twin_braids", "hair_bun", "double_bun",
        "steamed_bun", "ponytail_holder", "blunt_bangs",
    ]

    def setUp(self):
        self.got = pairs(at.generate_candidates(self.VOCAB), "hairstyle")

    def test_variant_pairs_with_its_base_style(self):
        self.assertIn(("high_ponytail", "ponytail"), self.got)
        self.assertIn(("low_twintails", "twintails"), self.got)
        self.assertIn(("braided_ponytail", "ponytail"), self.got)
        self.assertIn(("braid", "twin_braids"), self.got)

    def test_named_cuts_pair_with_their_variants(self):
        got = pairs(at.generate_candidates(["bob_cut", "inverted_bob", "pixie_cut", "eyebrow_cut", "cut-in"]), "hairstyle")
        self.assertEqual(got, {("bob_cut", "inverted_bob")})

    def test_different_styles_and_non_hairstyles_do_not_pair(self):
        self.assertNotIn(("ponytail", "twintails"), self.got)
        # 只差修饰词的两个变体不互相配对，各自与基本形配对。
        self.assertNotIn(("high_ponytail", "low_ponytail"), self.got)
        self.assertNotIn(("hair_bun", "twin_braids"), self.got)
        names = {n for p in self.got for n in p}
        self.assertNotIn("steamed_bun", names)
        self.assertNotIn("ponytail_holder", names)
        self.assertNotIn("blunt_bangs", names)


class BangsCandidates(unittest.TestCase):
    VOCAB = [
        "blunt_bangs", "parted_bangs", "double-parted_bangs", "bangs_pinned_back",
        "gangbang", "colored_bangs", "ponytail",
    ]

    def test_bangs_shapes_pair_by_shared_words(self):
        got = pairs(at.generate_candidates(self.VOCAB), "bangs")
        self.assertIn(("blunt_bangs", "parted_bangs"), got)
        self.assertIn(("double-parted_bangs", "parted_bangs"), got)
        self.assertNotIn(("bangs_pinned_back", "blunt_bangs"), got)
        names = {n for p in got for n in p}
        self.assertNotIn("gangbang", names)
        self.assertNotIn("colored_bangs", names)


VOCAB_SOURCE = at.VocabularySource(
    name="PixAI Tagger v1.0", url="https://example.invalid/selected_tags.csv", sha256="ab" * 32
)
REVIEW_HEADER = "category\ta\tb\tverdict\treason\n"


def review(*rows):
    return REVIEW_HEADER + "".join("\t".join(r) + "\n" for r in rows)


class BuildTable(unittest.TestCase):
    VOCAB = ["blue_eyes", "aqua_eyes", "green_eyes"]

    def cands(self):
        return at.generate_candidates(self.VOCAB)

    def full_review(self, reject=()):
        rows = []
        for c in self.cands():
            verdict = "reject" if (c.a, c.b) in reject else "accept"
            rows.append((c.category, c.a, c.b, verdict, "理由"))
        return review(*rows)

    def test_only_accepted_pairs_enter_the_table(self):
        reviews = at.parse_review(self.full_review(reject={("blue_eyes", "green_eyes")}))
        table = at.build_table(self.cands(), reviews, VOCAB_SOURCE, previous=None)
        self.assertEqual(
            table["pairs"],
            [
                {"category": "eye_color", "a": "aqua_eyes", "b": "blue_eyes"},
                {"category": "eye_color", "a": "aqua_eyes", "b": "green_eyes"},
            ],
        )
        self.assertEqual(table["format"], "kinshoko.builtin-approx-table")
        self.assertEqual(table["format_version"], 1)
        self.assertEqual(table["table_version"], 1)
        self.assertEqual(table["vocabulary"]["sha256"], "ab" * 32)

    def test_unreviewed_candidates_stop_the_build(self):
        reviews = at.parse_review(review(("eye_color", "aqua_eyes", "blue_eyes", "accept", "相近")))
        with self.assertRaises(at.ReviewError) as e:
            at.build_table(self.cands(), reviews, VOCAB_SOURCE, previous=None)
        self.assertIn("aqua_eyes\tgreen_eyes", str(e.exception))

    def test_review_of_a_pair_that_is_no_longer_a_candidate_stops_the_build(self):
        text = self.full_review() + "eye_color\tblue_eyes\tred_eyes\taccept\t旧候选\n"
        with self.assertRaises(at.ReviewError) as e:
            at.build_table(self.cands(), at.parse_review(text), VOCAB_SOURCE, previous=None)
        self.assertIn("red_eyes", str(e.exception))

    def test_review_rows_need_a_known_verdict_and_a_reason(self):
        with self.assertRaises(at.ReviewError):
            at.parse_review(review(("eye_color", "aqua_eyes", "blue_eyes", "maybe", "?")))
        with self.assertRaises(at.ReviewError):
            at.parse_review(review(("eye_color", "aqua_eyes", "blue_eyes", "accept", "")))


class TableVersion(unittest.TestCase):
    VOCAB = ["blue_eyes", "aqua_eyes"]

    def build(self, verdict, previous):
        cands = at.generate_candidates(self.VOCAB)
        reviews = at.parse_review(review(("eye_color", "aqua_eyes", "blue_eyes", verdict, "理由")))
        return at.render_table(at.build_table(cands, reviews, VOCAB_SOURCE, previous=previous))

    def test_rebuilding_unchanged_content_is_byte_identical_and_keeps_the_version(self):
        first = self.build("accept", previous=None)
        again = self.build("accept", previous=first)
        self.assertEqual(first, again)

    def test_changed_content_bumps_the_version(self):
        first = self.build("accept", previous=None)
        second = self.build("reject", previous=first)
        self.assertEqual(at.json.loads(second)["table_version"], 2)
        self.assertEqual(at.json.loads(second)["pairs"], [])

    def test_rendered_file_lists_one_pair_per_line(self):
        text = self.build("accept", previous=None)
        self.assertIn('\n    {"category": "eye_color", "a": "aqua_eyes", "b": "blue_eyes"}\n', text)
        self.assertTrue(text.endswith("}\n"))


CSV_TEXT = (
    "tag_id,name,category,count\n"
    "0,blue_eyes,0,0\n"
    "1,aqua_eyes,0,0\n"
    "2,blue_eyes_(character),4,0\n"
    "3,general,9,0\n"
)


class Vocabulary(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.csv = os.path.join(self.dir.name, "selected_tags.csv")
        with open(self.csv, "w", encoding="utf-8", newline="") as f:
            f.write(CSV_TEXT)
        self.sha = hashlib.sha256(CSV_TEXT.encode()).hexdigest()

    def tearDown(self):
        self.dir.cleanup()

    def test_reads_general_tag_names_only(self):
        self.assertEqual(at.load_vocabulary(self.csv, self.sha), ["blue_eyes", "aqua_eyes"])

    def test_refuses_a_vocabulary_file_with_another_hash(self):
        with self.assertRaises(at.VocabularyError):
            at.load_vocabulary(self.csv, "00" * 32)


class CommandLine(Vocabulary):
    def run_cli(self, *args):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            code = at.main(["--vocab", self.csv, "--vocab-sha256", self.sha, *args])
        return code, out.getvalue()

    def write_review(self, verdict):
        path = os.path.join(self.dir.name, "review.tsv")
        with open(path, "w", encoding="utf-8") as f:
            f.write(review(("eye_color", "aqua_eyes", "blue_eyes", verdict, "理由")))
        return path

    def test_build_writes_the_table_and_check_confirms_it_is_current(self):
        out = os.path.join(self.dir.name, "table.json")
        rev = self.write_review("accept")
        code, _ = self.run_cli("build", "--review", rev, "--out", out)
        self.assertEqual(code, 0)
        with open(out, encoding="utf-8") as f:
            self.assertEqual(at.json.loads(f.read())["pairs"][0]["b"], "blue_eyes")
        self.assertEqual(self.run_cli("check", "--review", rev, "--out", out)[0], 0)

        rev = self.write_review("reject")
        code, msg = self.run_cli("check", "--review", rev, "--out", out)
        self.assertEqual(code, 1)
        self.assertIn("build", msg)

    def test_pending_lists_unreviewed_candidates_as_review_rows(self):
        rev = os.path.join(self.dir.name, "empty.tsv")
        with open(rev, "w", encoding="utf-8") as f:
            f.write(REVIEW_HEADER)
        code, out = self.run_cli("pending", "--review", rev)
        self.assertEqual(code, 0)
        self.assertIn("eye_color\taqua_eyes\tblue_eyes\t\t", out)


if __name__ == "__main__":
    unittest.main()
