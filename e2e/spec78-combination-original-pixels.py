"""T20 pure file oracle. Importing this module never observes the desktop or clipboard.

The crop follows the public geometric contract: undo clockwise quarter turns,
undo flips, then map selection edges into the original crop with exact fractions.
Actual clipboard bytes are supplied by the separately granted native observer.
"""
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import sys

from PIL import Image


def original_region(source, selected):
    shown = source["shown"]
    for key in ("x", "y", "width", "height"):
        if not isinstance(shown[key], int) or not isinstance(selected[key], int):
            raise ValueError("Geometric input must use actual integer physical pixels")
    if min(shown["width"], shown["height"], selected["width"], selected["height"]) <= 0:
        raise ValueError("Empty source or selection")
    if (selected["x"] < shown["x"] or selected["y"] < shown["y"]
            or selected["x"] + selected["width"] > shown["x"] + shown["width"]
            or selected["y"] + selected["height"] > shown["y"] + shown["height"]):
        raise ValueError("Selection is not wholly within the shown source")
    crop = source.get("crop") or {"x": 0, "y": 0, "width": source["sourceWidth"], "height": source["sourceHeight"]}
    placement = source["placement"]
    corners = []
    for sx in (selected["x"], selected["x"] + selected["width"]):
        for sy in (selected["y"], selected["y"] + selected["height"]):
            x = Fraction(sx - shown["x"], shown["width"])
            y = Fraction(sy - shown["y"], shown["height"])
            u, v = ((x, y), (y, 1 - x), (1 - x, 1 - y), (1 - y, x))[placement["rotation"] % 4]
            if placement["flipH"]:
                u = 1 - u
            if placement["flipV"]:
                v = 1 - v
            corners.append((u * crop["width"], v * crop["height"]))
    left, top = math.floor(min(x for x, _ in corners)), math.floor(min(y for _, y in corners))
    right, bottom = math.ceil(max(x for x, _ in corners)), math.ceil(max(y for _, y in corners))
    region = {"x": crop["x"] + left, "y": crop["y"] + top, "width": right - left, "height": bottom - top}
    if (region["x"] < 0 or region["y"] < 0 or region["width"] <= 0 or region["height"] <= 0
            or region["x"] + region["width"] > source["sourceWidth"]
            or region["y"] + region["height"] > source["sourceHeight"]):
        raise ValueError("Expected crop is outside the original")
    return region


def expected_pixels(original, source, selected):
    image = Image.open(original).convert("RGBA")
    if list(image.size) != [source["sourceWidth"], source["sourceHeight"]]:
        raise ValueError("Fixture original dimensions differ from the real source")
    region = original_region(source, selected)
    x, y, width, height = (region[key] for key in ("x", "y", "width", "height"))
    image = image.crop((x, y, x + width, y + height))
    placement = source["placement"]
    if placement["flipH"]:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if placement["flipV"]:
        image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    for _ in range(placement["rotation"] % 4):
        image = image.transpose(Image.Transpose.ROTATE_270)
    return region, image


def describe(image):
    rgba = image.convert("RGBA")
    return {"size": list(rgba.size), "rgbaBytes": len(rgba.tobytes()),
            "rgbaSha256": hashlib.sha256(rgba.tobytes()).hexdigest(),
            "alphaExtrema": list(rgba.getchannel("A").getextrema()),
            "corners": [list(rgba.getpixel(point)) for point in ((0, 0), (rgba.width - 1, 0), (0, rgba.height - 1), (rgba.width - 1, rgba.height - 1))]}


def compare(original, source, selected, actual_path):
    region, expected = expected_pixels(original, source, selected)
    actual = Image.open(actual_path).convert("RGBA")
    expected_summary, actual_summary = describe(expected), describe(actual)
    matches = expected.size == actual.size and expected.tobytes() == actual.tobytes()
    mismatch = None
    if expected.size == actual.size and not matches:
        for index, (a, b) in enumerate(zip(expected.tobytes(), actual.tobytes())):
            if a != b:
                pixel, channel = divmod(index, 4)
                mismatch = {"x": pixel % expected.width, "y": pixel // expected.width, "channel": "RGBA"[channel], "expected": a, "actual": b}
                break
    return {"crop": region, "placement": source["placement"], "expected": expected_summary,
            "actual": actual_summary, "matches": matches, "firstMismatch": mismatch,
            "oracle": "original RGBA crop, exact rational inverse affine, flips before clockwise turns"}


def main():
    request = json.loads(sys.stdin.read())
    if request["mode"] == "describe":
        region, image = expected_pixels(request["original"], request["source"], request["selected"])
        result = {"crop": region, "expected": describe(image)}
    elif request["mode"] == "inspect":
        result = describe(Image.open(request["actual"]))
    elif request["mode"] == "frozen":
        image = Image.open(request["actual"]).convert("RGBA")
        expected = request["frozen"]
        if not (expected["width"] <= image.width <= expected["width"] + 1 and expected["height"] <= image.height <= expected["height"] + 1):
            raise ValueError("Actual native overlay screenshot does not cover the physical frozen monitor")
        r = request["region"]
        if r["x"] < 0 or r["y"] < 0 or r["width"] <= 4 or r["height"] <= 4 or r["x"] + r["width"] > expected["width"] or r["y"] + r["height"] > expected["height"]:
            raise ValueError("Actual overlay selection is outside the frozen raster")
        # Exclude the actual overlay outline. This only proves that an image was
        # painted; the complete clipboard-vs-original oracle proves its content.
        interior = image.crop((r["x"] + 2, r["y"] + 2, r["x"] + r["width"] - 2, r["y"] + r["height"] - 2))
        extrema = interior.convert("RGB").getextrema()
        result = {"raster": list(image.size), "physicalSelection": r,
                  "interior": describe(interior), "rgbExtrema": [list(pair) for pair in extrema],
                  "paintedNonuniform": any(high > low for low, high in extrema)}
    elif request["mode"] == "compare":
        result = compare(request["original"], request["source"], request["selected"], request["actual"])
    else:
        raise ValueError("Only pure owned image-file operations are supported")
    print(json.dumps(result))
    if result.get("matches") is False:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
