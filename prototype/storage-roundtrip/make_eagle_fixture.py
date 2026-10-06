"""PROTOTYPE — 给 eagle_check.py 做自测用的“像真的” Eagle 资料库。

python make_eagle_fixture.py <输出目录> [--images <图片目录>] [--n 150]

在 <输出目录> 下生成：
  appdata/Eagle/Settings     假的 Eagle 设置，libraryHistory 指向下面两个库（测试自动查找）
  libs/主库.library           n 项：嵌套文件夹、一图多文件夹、链接、备注、区域评论、回收站、同库重复、无文件夹
  libs/第二个库.library       20 项
用法：APPDATA=<输出目录>/appdata python eagle_check.py --yes --no-questions --no-open
"""
import argparse, json, os, random, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eagle_sample as es  # noqa: E402


def build(lib, n, images, rnd, name_prefix):
    os.makedirs(lib, exist_ok=True)
    F = {k: es.eagle_id(name_prefix + k) for k in ("role", "girl", "hair", "light")}
    folders = [es.folder(F["role"], "角色", [es.folder(F["girl"], "女")]), es.folder(F["hair"], "发型参考"), es.folder(F["light"], "光照")]
    items = []
    dup_bytes = None
    for i in range(n):
        if images:
            src = images[i % len(images)]
            data = open(src, "rb").read()
            if i >= len(images):
                data += i.to_bytes(4, "big")
            ext = src.rsplit(".", 1)[-1].lower()
            w, h = 1000 + i, 1400 - i  # 自测不解码；数值只需自洽
        else:
            w, h = 20 + i % 30, 20 + i % 17
            data = es.png(w, h, f"{name_prefix}{i}")
            ext = "png"
        if i == 7:
            dup_bytes = (data, ext, w, h)
        if i == 8 and dup_bytes:  # 同库重复
            data, ext, w, h = dup_bytes
        fs = rnd.choice([[], [F["girl"]], [F["hair"]], [F["girl"], F["hair"]], [F["light"]]])
        comments = []
        if i % 25 == 3:
            comments = [{"id": f"C{i}a", "x": int(w * .3), "y": int(h * .2), "width": int(w * .2), "height": int(h * .15),
                         "annotation": "眼睛", "lastModified": 1760000000000 + i}]
        m = es.item_meta(es.eagle_id(f"{name_prefix}{i}"), f"图{i:04d}", data, w, h,
                         tags=rnd.sample(["蓝发", "长发", "短发", "侧脸", "逆光", "齐刘海", "双马尾", "回头"], rnd.randint(0, 5)),
                         folders=fs, url=f"https://www.pixiv.net/artworks/{100000000 + i}" if i % 3 else "",
                         annotation="看高光" if i % 7 == 0 else "", deleted=(i % 40 == 5), comments=comments)
        m["ext"] = ext
        es.put_item(lib, m, data)
        items.append(m)
    es.finish_library(lib, folders, items, smart=[{"id": "S1", "name": "蓝发", "conditions": []}],
                      tag_groups=[{"id": "TG1", "name": "发色", "tags": ["蓝发"], "color": "blue"}])
    return lib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--images")
    ap.add_argument("--n", type=int, default=150)
    a = ap.parse_args()
    rnd = random.Random(8)
    shutil.rmtree(a.out, ignore_errors=True)
    images = sorted(os.path.join(a.images, f) for f in os.listdir(a.images)
                    if f.lower().rsplit(".", 1)[-1] in ("jpg", "jpeg", "png", "webp", "gif")) if a.images else []
    main_lib = build(os.path.join(a.out, "libs", "主库.library"), a.n, images, rnd, "m")
    second = build(os.path.join(a.out, "libs", "第二个库.library"), 20, images[::-1], rnd, "s")
    settings = os.path.join(a.out, "appdata", "Eagle")
    os.makedirs(settings)
    with open(os.path.join(settings, "Settings"), "w", encoding="utf-8") as f:
        json.dump({"libraryHistory": [os.path.abspath(main_lib), os.path.abspath(second)], "currentLibraryPath": os.path.abspath(main_lib)}, f)
    print(os.path.abspath(a.out))


if __name__ == "__main__":
    main()
