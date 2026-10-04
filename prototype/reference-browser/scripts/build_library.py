"""Build the prototype's in-memory libraries from the validation sample manifests.

Usage: python scripts/build_library.py [--samples-dir DIR] [--no-fetch] [--predictions FILE]

- Reads docs/validation/sample-manifest.pixiv*.json and finds the images under samples/
  (this checkout, or the main checkout when running in a git worktree). Files are
  checked against the manifest SHA-256; missing or mismatched samples are skipped.
- pixiv author names and titles come from pixiv's public /ajax/illust endpoint and are
  cached in .local/pixiv-meta.json. --no-fetch uses the cache only.
- --predictions merges a tagger-probe predictions.jsonl (#6) as auto tag suggestions.
- Writes .local/library.json and .local/media/. Both stay out of git: the sample
  images are not redistributable. Self-made display fixtures are drawn here too.
"""
import argparse, hashlib, json, os, re, subprocess, sys, time, urllib.request

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, ".local")
MEDIA = os.path.join(OUT, "media")
THUMB_WIDTH = 512
VIEW_LIMIT = 4096  # originals at or below this long side are copied unchanged

# ---------------------------------------------------------------- tag dictionary
# Kinshoko tags are library-owned: a namespace, a Chinese display name and aliases.
# pixiv author tags are the source result; aliases make 中文／日文／Danbooru wording match.
GENERAL = {
    # 标签分组: 发色
    "金发": ("发色", ["金髪", "blonde_hair", "黄发", "黄毛"]),
    "黑发": ("发色", ["黒髪", "黑髮", "black_hair", "黑毛"]),
    "蓝发": ("发色", ["青髪", "blue_hair", "蓝头发", "蓝毛"]),
    "浅蓝发": ("发色", ["水色髪", "light_blue_hair", "水色头发"]),
    "白发": ("发色", ["白髪", "white_hair", "白毛"]),
    "银发": ("发色", ["銀髪", "grey_hair", "白毛", "灰发"]),
    "红发": ("发色", ["赤髪", "red_hair", "红毛"]),
    "粉发": ("发色", ["ピンク髪", "pink_hair", "粉毛", "粉色头发"]),
    "棕发": ("发色", ["茶髪", "brown_hair", "茶发"]),
    "绿发": ("发色", ["緑髪", "green_hair"]),
    "紫发": ("发色", ["紫髪", "purple_hair"]),
    # 发型
    "双马尾": ("发型", ["ツインテール", "ツインテ", "twintails", "双马"]),
    "单马尾": ("发型", ["ポニーテール", "ponytail", "马尾"]),
    "麻花辫": ("发型", ["三つ編み", "braid", "辫子"]),
    "侧马尾": ("发型", ["ルーズサイドテール", "side_ponytail"]),
    "丸子头": ("发型", ["お団子頭", "hair_bun"]),
    "半扎发": ("发型", ["ハーフアップ", "ツーサイドアップ", "half_updo"]),
    # 刘海
    "齐刘海": ("刘海", ["ぱっつん", "前髪ぱっつん", "blunt_bangs", "平刘海"]),
    "姬发式": ("刘海", ["姫カット", "hime_cut", "公主切"]),
    "中分": ("刘海", ["センター分け", "センターパート", "middle_part", "parted_bangs"]),
    "遮眼发": ("刘海", ["片目隠れ", "hair_over_one_eye"]),
    # 发长
    "短发": ("发长", ["ショートカット", "ショートヘア", "ショートヘアー", "short_hair"]),
    "长发": ("发长", ["ロングヘア", "ロングヘアー", "long_hair"]),
    "超长发": ("发长", ["超ロングヘア", "very_long_hair"]),
    "波波头": ("发长", ["ボブ", "ボブカット", "おかっぱ", "bob_cut"]),
    # 画面
    "线稿": ("画面", ["線画", "ペン画", "lineart"]),
    "黑白": ("画面", ["モノクロ", "白黒", "モノクロ画", "greyscale", "monochrome", "灰度"]),
    "厚涂": ("画面", ["厚塗り", "油彩", "thick_paint"]),
    "逆光": ("画面", ["backlighting"]),
    "全身": ("画面", ["full_body", "立ち絵"]),
    "半身": ("画面", ["バストアップ", "upper_body"]),
    "多人": ("画面", ["集合絵", "group"]),
    "背景": ("画面", ["風景", "风景", "场景", "scenery"]),
    "教程": ("画面", ["講座", "メイキング", "描き方", "tips", "技法"]),
    "原创": (None, ["オリジナル", "創作", "OC", "oc", "オリキャラ", "オリジナルキャラ", "オリジナルキャラクター", "うちの子", "original"]),
    "女孩": (None, ["女の子", "少女", "美少女"]),
    "笑脸": (None, ["笑顔"]),
    "泳装": (None, ["水着"]),
    "制服": (None, ["セーラー服", "女子高生", "JK"]),
}
SPLIT_TAGS = {"黒髪ロング": ["黑发", "长发"], "茶髪ロング": ["棕发", "长发"], "黒髪ツインテール": ["黑发", "双马尾"],
              "銀髪碧眼": ["银发"], "両手にツインテ": ["双马尾"]}
WORKS = {
    "原神": ["GenshinImpact", "Genshin", "genshinimpact", "genshinimpactfanart"],
    "绝区零": ["ゼンレスゾーンゼロ", "ZenlessZoneZero", "ゼンゼロ", "zzzero", "zzzreo"],
    "蔚蓝档案": ["ブルーアーカイブ", "ブルアカ", "BlueArchive", "블루아카이브", "碧蓝档案"],
    "Fate/Grand Order": ["Fate/GrandOrder", "FGO", "Fate/GO"],
    "VOCALOID": ["ボカロ"],
    "碧蓝航线": ["アズールレーン", "アズレン", "AzurLane"],
    "鸣潮": ["鳴潮", "WutheringWaves"],
    "胜利女神：妮姬": ["勝利の女神:NIKKE", "NIKKE"],
    "明日方舟": ["アークナイツ", "Arknights", "arknights"],
    "明日方舟：终末地": ["アークナイツ:エンドフィールド", "アークナイツエンドフィールド", "ArknightsEndfield", "エンドフィールド", "明日方舟終末地"],
    "崩坏：星穹铁道": ["崩壊スターレイル", "崩壊:スターレイル", "HonkaiStarRail", "崩坏星穹铁道"],
    "hololive": ["ホロライブ", "HololiveEN", "ホロライブEN"],
    "孤独摇滚！": ["ぼっち・ざ・ろっく!"],
    "东方Project": ["東方", "東方Project"],
    "Re:从零开始的异世界生活": ["Re:ゼロから始める異世界生活", "リゼロ"],
    "BanG Dream!": ["BanG_Dream!", "バンドリ"],
    "魔法少女的魔女审判": ["魔法少女ノ魔女裁判", "まのさば"],
}
CHARACTERS = {"初音未来": ["初音ミク", "miku", "Miku", "初音"]}
DROP = re.compile(r"users入り$|^(C108|pr|自分タグ|R-18|クリック推奨|版権|イラスト|Illustration|插图|插画|fanart|ファンアート|二次創作)$")


def tag_index():
    index, defs = {}, {}
    def add(ns, name, group, aliases):
        key = f"{ns}:{name}"
        defs[key] = {"ns": ns, "name": name, "group": group, "aliases": aliases}
        for alias in [name, *aliases]:
            index.setdefault(alias, []).append(key)
    for name, (group, aliases) in GENERAL.items():
        add("一般", name, group, aliases)
    for name, aliases in WORKS.items():
        add("作品", name, None, aliases)
    for name, aliases in CHARACTERS.items():
        add("角色", name, None, aliases)
    return index, defs


def map_pixiv_tags(raw, index, defs):
    keys = []
    def push(key):
        if key not in keys:
            keys.append(key)
    for tag in raw:
        if DROP.search(tag):
            continue
        if tag in SPLIT_TAGS:
            for name in SPLIT_TAGS[tag]:
                push(f"一般:{name}")
            continue
        hits = index.get(tag, [])
        if len(hits) == 1:  # an ambiguous alias (白毛) is a search word, not a source tag
            push(hits[0])
            continue
        m = re.fullmatch(r"(.+?)\((.+)\)", tag)  # pixiv convention: キャラ名(作品名)
        if m:
            name, work = m.groups()
            key = f"角色:{name}"
            defs.setdefault(key, {"ns": "角色", "name": name, "group": None, "aliases": []})
            push(key)
            for wk in index.get(work, []):
                push(wk)
            continue
        key = f"一般:{tag}"
        defs.setdefault(key, {"ns": "一般", "name": tag, "group": None, "aliases": []})
        push(key)
    return keys


# ---------------------------------------------------------------- samples

def find_samples_root(explicit):
    if explicit:
        return explicit
    candidates = [os.path.join(REPO, "samples")]
    try:
        common = subprocess.check_output(["git", "rev-parse", "--git-common-dir"], cwd=REPO, text=True).strip()
        candidates.append(os.path.join(os.path.dirname(os.path.abspath(os.path.join(REPO, common))), "samples"))
    except Exception:
        pass
    return next((c for c in candidates if os.path.isdir(c)), None)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch_meta(ids, cache_path, allow_fetch):
    cache = json.load(open(cache_path, encoding="utf-8")) if os.path.exists(cache_path) else {}
    todo = [i for i in ids if i not in cache]
    if todo and allow_fetch:
        print(f"fetching pixiv metadata for {len(todo)} works", flush=True)
        headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.pixiv.net/"}
        for n, art in enumerate(todo, 1):
            try:
                req = urllib.request.Request(f"https://www.pixiv.net/ajax/illust/{art}", headers=headers)
                body = json.loads(urllib.request.urlopen(req, timeout=60).read())["body"]
                cache[art] = {"userName": body["userName"], "userId": body["userId"], "title": body["title"],
                              "createDate": body.get("createDate")}
            except Exception as e:
                print("  meta failed", art, e)
            time.sleep(1.0)
            if n % 25 == 0:
                print(f"  [{n}/{len(todo)}]", flush=True)
                json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return cache


def load_predictions(path):
    """predictions.jsonl from tools/tagger-probe: one object per sample and run."""
    out = {}
    if not path:
        return out
    for line in open(path, encoding="utf-8"):
        row = json.loads(line)
        sid = row.get("sample") or row.get("id")
        tags = row.get("tags") or {}
        if sid and tags and sid not in out:
            out[sid] = {"model": row.get("model", "PixAI"), "tags": tags, "rating": row.get("rating")}
    return out


def write_media(src, stem):
    cached = os.path.join(OUT, "media", "cache.json")
    cache = json.load(open(cached, encoding="utf-8")) if os.path.exists(cached) else {}
    if stem in cache and all(os.path.exists(os.path.join(OUT, cache[stem][k])) for k in ("thumb", "view")):
        return cache[stem]
    img = Image.open(src)
    w, h = img.size
    thumb = f"media/t/{stem}.webp"
    t = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
    if w > THUMB_WIDTH:
        t = t.resize((THUMB_WIDTH, max(1, round(h * THUMB_WIDTH / w))), Image.LANCZOS)
    t.save(os.path.join(OUT, thumb), "WEBP", quality=82, method=5)
    ext = os.path.splitext(src)[1].lower()
    if max(w, h) <= VIEW_LIMIT:
        view = f"media/o/{stem}{ext}"
        with open(src, "rb") as a, open(os.path.join(OUT, view), "wb") as b:
            b.write(a.read())
        scale = 1
    else:
        scale = VIEW_LIMIT / max(w, h)
        view = f"media/o/{stem}.jpg"
        img.convert("RGB").resize((round(w * scale), round(h * scale)), Image.LANCZOS).save(
            os.path.join(OUT, view), "JPEG", quality=92)
    cache[stem] = {"thumb": thumb, "view": view, "w": w, "h": h, "viewScale": scale, "format": ext.lstrip(".").upper()}
    json.dump(cache, open(cached, "w", encoding="utf-8"))
    return cache[stem]


def draw_fixtures():
    """Self-made display tests the pixiv set lacks: transparency, extreme ratios, fine lines."""
    specs = []
    def save(stem, img, title, tags):
        path = os.path.join(OUT, f"media/o/{stem}.png")
        img.save(path)
        t = img.copy()
        if t.width > THUMB_WIDTH:
            t = t.resize((THUMB_WIDTH, max(1, round(t.height * THUMB_WIDTH / t.width))), Image.LANCZOS)
        t.save(os.path.join(OUT, f"media/t/{stem}.webp"), "WEBP", lossless=True)
        specs.append({"stem": stem, "title": title, "tags": tags, "w": img.width, "h": img.height})

    a = Image.new("RGBA", (1200, 1200), (0, 0, 0, 0))
    d = ImageDraw.Draw(a)
    d.ellipse((150, 150, 1050, 1050), fill=(224, 118, 143, 150))
    d.rectangle((420, 420, 780, 780), outline=(43, 39, 71, 255), width=14)
    save("fixture-alpha", a, "透明：半透明圆与描边", ["透明"])
    tall = Image.new("RGB", (400, 3600), (244, 236, 220))
    d = ImageDraw.Draw(tall)
    for i in range(12):
        d.rectangle((60, 60 + i * 295, 340, 300 + i * 295), fill=[(43, 39, 71), (227, 179, 79), (224, 118, 143)][i % 3])
    save("fixture-tall", tall, "极长图 1:9", ["极长图"])
    wide = Image.new("RGB", (4200, 600), (247, 243, 234))
    d = ImageDraw.Draw(wide)
    for i in range(14):
        d.rectangle((40 + i * 298, 80, 300 + i * 298, 520), fill=[(43, 39, 71), (227, 179, 79), (224, 118, 143)][i % 3])
    save("fixture-wide", wide, "极宽图 7:1", ["极宽图"])
    lines = Image.new("RGB", (1600, 1600), (255, 255, 255))
    d = ImageDraw.Draw(lines)
    for x in range(0, 1600, 8):
        d.line((x, 0, x, 1599), fill=(0, 0, 0), width=1)
    for y in range(0, 1600, 40):
        d.line((0, y, 1599, y), fill=(224, 118, 143), width=1)
    save("fixture-lines", lines, "细线：1 px 间隔 8 px", ["细线"])
    tiny = Image.new("RGB", (64, 64), (43, 39, 71))
    ImageDraw.Draw(tiny).rectangle((16, 16, 47, 47), outline=(227, 179, 79), width=2)
    save("fixture-tiny", tiny, "小图 64×64", ["小图"])
    return specs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples-dir")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--predictions")
    args = ap.parse_args()
    os.makedirs(os.path.join(MEDIA, "t"), exist_ok=True)
    os.makedirs(os.path.join(MEDIA, "o"), exist_ok=True)

    index, defs = tag_index()
    root = find_samples_root(args.samples_dir)
    manifests = [("pixiv", "sample-manifest.pixiv.json"), ("pixiv-r18", "sample-manifest.pixiv-r18.json")]
    samples = []
    for folder, name in manifests:
        for s in json.load(open(os.path.join(REPO, "docs/validation", name), encoding="utf-8"))["samples"]:
            samples.append((folder, s))
    meta = fetch_meta([s["source"]["artworkId"] for _, s in samples], os.path.join(OUT, "pixiv-meta.json"),
                      not args.no_fetch) if root else {}
    predictions = load_predictions(args.predictions)

    images, skipped = [], []
    for folder, s in samples:
        art, page = s["source"]["artworkId"], s["source"]["page"]
        directory = os.path.join(root, folder) if root else None
        hit = None
        if directory and os.path.isdir(directory):
            hit = next((os.path.join(directory, n) for n in os.listdir(directory)
                        if re.match(rf"{art}(-[0-9a-f]+)?_p{page}\.", n)), None)
        if not hit or sha256(hit) != s["sha256"]:
            skipped.append(s["id"])
            continue
        media = write_media(hit, s["id"])
        info = meta.get(art, {})
        raw = s.get("authorTags", [])
        tags = map_pixiv_tags(raw, index, defs)
        if info.get("userName"):
            key = f"作者:{info['userName']}"
            defs.setdefault(key, {"ns": "作者", "name": info["userName"], "group": None, "aliases": []})
            tags.insert(0, key)
        r18 = "r18" in s["coverage"]
        rating = {"value": "explicit" if r18 else ("sensitive" if "sensitive" in s["coverage"] else "general"),
                  "from": "pixiv R-18 标记" if r18 else ("pixiv 敏感标记" if "sensitive" in s["coverage"] else "pixiv 全年龄")}
        auto = predictions.get(s["id"])
        images.append({
            "id": s["id"], "sha256": s["sha256"], "title": info.get("title") or f"pixiv {art}",
            "date": info.get("createDate"),
            **media,
            "sourceTags": [{"tag": t, "from": "pixiv"} for t in tags],
            "autoTags": [{"tag": t, "score": v} for t, v in (auto or {}).get("tags", {}).items()],
            "autoModel": (auto or {}).get("model"),
            "rating": rating,
            "sourceLinks": [{"url": f"https://www.pixiv.net/artworks/{art}", "from": "pixiv"}],
            "coverage": s["coverage"], "split": s["split"],
        })

    fixtures = draw_fixtures()
    for f in fixtures:
        images.append({
            "id": f["stem"], "sha256": None, "title": f["title"], "date": None, "thumb": f"media/t/{f['stem']}.webp",
            "view": f"media/o/{f['stem']}.png", "w": f["w"], "h": f["h"], "viewScale": 1, "format": "PNG",
            "sourceTags": [{"tag": f"一般:{t}", "from": "自制"} for t in f["tags"]], "autoTags": [], "autoModel": None,
            "rating": {"value": "general", "from": "自制"}, "sourceLinks": [], "coverage": [], "split": "fixture",
        })
        for t in f["tags"]:
            defs.setdefault(f"一般:{t}", {"ns": "一般", "name": t, "group": "显示测试", "aliases": []})

    used = {t["tag"] for im in images for t in im["sourceTags"]}
    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "samplesRoot": bool(root), "skipped": skipped,
        "hasPredictions": bool(predictions),
        "tags": {k: v for k, v in defs.items() if k in used or v["group"]},
        "images": images,
    }
    json.dump(out, open(os.path.join(OUT, "library.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{len(images) - len(fixtures)} samples + {len(fixtures)} fixtures; skipped {len(skipped)}")
    if not root:
        print("samples/ not found: only fixtures were written. See scripts/samples/fetch_pixiv.py.")


if __name__ == "__main__":
    sys.exit(main())
