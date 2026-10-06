"""内置近似对应表生成脚本的测试。运行：python -m unittest（在本目录下）。"""

import unittest

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


if __name__ == "__main__":
    unittest.main()
