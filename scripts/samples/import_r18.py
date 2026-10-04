"""Build the R-18 sample manifest from manually downloaded pixiv files.

Usage: python scripts/samples/import_r18.py [src] [manifest]
Defaults: samples/pixiv-r18/ -> docs/validation/sample-manifest.pixiv-r18.json

Keep pixiv's file names (<artworkId>_p<page>.<ext>; an optional -<hash> after the
artwork ID is accepted). Ground truth is pixiv's R-18 flag only: no degree and no
author tags are needed. Re-running rebuilds the manifest.
"""
import hashlib, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "samples/pixiv-r18")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "docs/validation/sample-manifest.pixiv-r18.json")
NAME = re.compile(r"^(\d+)(?:-[0-9a-f]+)?_p(\d+)\.(jpe?g|png|gif|webp)$", re.IGNORECASE)

samples, skipped = [], []
for name in sorted(os.listdir(src)):
    path = os.path.join(src, name)
    if not os.path.isfile(path):
        continue
    m = NAME.match(name)
    if not m:
        skipped.append(name)
        continue
    art, page = m.group(1), int(m.group(2))
    samples.append({
        "id": f"pixiv-{art}-p{page}",
        "source": {"kind": "pixiv", "artworkId": art, "page": page},
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "split": "calibration" if int(hashlib.sha256(art.encode()).hexdigest(), 16) % 5 == 0 else "evaluation",
        "coverage": ["r18"],
        "rating": "r18",
    })

json.dump({"version": 1, "samples": samples}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(samples)} samples written to {out}")
for s in skipped:
    print("  skipped (name must be <artworkId>_p<page>.<ext>):", s)
