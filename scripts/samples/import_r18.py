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
# Pages reviewed as only suggestive: pixiv's flag covers the whole work, not each page.
BORDERLINE = {
    "146794587": "首页本身只是擦边程度，pixiv R-18 标记针对整个作品；发起者 2026-10-04 复核，不计入分级正例。",
    "148019241": "首页本身只是擦边程度，pixiv R-18 标记针对整个作品；发起者 2026-10-04 复核，不计入分级正例。",
}
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
    sample = {
        "id": f"pixiv-{art}-p{page}",
        "source": {"kind": "pixiv", "artworkId": art, "page": page},
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "split": "calibration" if int(hashlib.sha256(art.encode()).hexdigest(), 16) % 5 == 0 else "evaluation",
        "coverage": ["r18"],
        "rating": "r18",
    }
    if art in BORDERLINE:
        sample["coverage"].append("r18-page-borderline")
        sample["notes"] = BORDERLINE[art]
    samples.append(sample)

json.dump({"version": 1, "samples": samples}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(samples)} samples written to {out}")
for s in skipped:
    print("  skipped (name must be <artworkId>_p<page>.<ext>):", s)
