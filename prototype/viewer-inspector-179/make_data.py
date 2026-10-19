"""PROTOTYPE (#179)：从参考浏览样稿生成的 .local 读样本图清单，写成 .local/images.js。

用法：python make_data.py <reference-browser 的 .local 目录>
图片不复制，images.js 里是指向原文件的 file:// 地址；样本图不能再分发，.local/ 不入库。
"""
import json
import pathlib
import sys

src = pathlib.Path(sys.argv[1]).resolve()
library = json.loads((src / "library.json").read_text(encoding="utf-8"))
images = []
for item in library["images"]:
    tags = [t["tag"].split(":", 1)[-1] for t in item.get("sourceTags", [])]
    images.append({
        "id": item["id"],
        "title": item.get("title") or item["id"],
        "thumb": (src / item["thumb"]).as_uri(),
        "view": (src / item["view"]).as_uri(),
        "w": item["w"],
        "h": item["h"],
        "format": item.get("format", ""),
        "tags": tags[:14],
    })
out = pathlib.Path(__file__).resolve().parent / ".local"
out.mkdir(exist_ok=True)
(out / "images.js").write_text("window.PROTO_IMAGES = " + json.dumps(images, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"{len(images)} images -> {out / 'images.js'}")
