"""Fetch and verify pixiv samples listed in a sample manifest.

Usage: python scripts/samples/fetch_pixiv.py [manifest] [dest]
Defaults: docs/validation/sample-manifest.pixiv.json -> samples/pixiv/

Only all-ages works whose original URL pixiv exposes without login are fetched.
Existing files are verified instead of re-downloaded. Exits 1 on any mismatch or failure.
"""
import hashlib, json, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
manifest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs/validation/sample-manifest.pixiv.json")
dest = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "samples/pixiv")
HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.pixiv.net/"}
os.makedirs(dest, exist_ok=True)


def fetch(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=120) as r:
        data = r.read()
    time.sleep(1.5)
    return data if binary else json.loads(data)


have = {}
for name in os.listdir(dest):
    if name.split("_p")[0].isdigit():
        have[name] = os.path.join(dest, name)

problems = []
samples = [s for s in json.load(open(manifest, encoding="utf-8"))["samples"] if s["source"]["kind"] == "pixiv"]
for i, s in enumerate(samples, 1):
    art, page = s["source"]["artworkId"], s["source"]["page"]
    local = next((p for n, p in have.items() if n.startswith(f"{art}_p{page}.")), None)
    try:
        if local is None:
            urls = fetch(f"https://www.pixiv.net/ajax/illust/{art}/pages")["body"]
            url = urls[page]["urls"]["original"]
            local = os.path.join(dest, url.rsplit("/", 1)[1])
            with open(local + ".part", "wb") as f:
                f.write(fetch(url, binary=True))
            os.replace(local + ".part", local)
        if hashlib.sha256(open(local, "rb").read()).hexdigest() != s["sha256"]:
            problems.append((s["id"], "sha256 mismatch"))
    except Exception as e:
        problems.append((s["id"], str(e)))
    if i % 20 == 0:
        print(f"[{i}/{len(samples)}]", flush=True)

print(f"{len(samples) - len(problems)}/{len(samples)} verified in {dest}")
for p in problems:
    print("  problem", *p)
sys.exit(1 if problems else 0)
