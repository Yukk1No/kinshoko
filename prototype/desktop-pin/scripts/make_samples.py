"""PROTOTYPE: generate self-made test images for the desktop pin probe (#7).

All images are generated here, so they can be committed without licensing questions.
Run: python scripts/make_samples.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
OUT.mkdir(parents=True, exist_ok=True)
FONT = ImageFont.load_default()


def pixel_grid() -> None:
    """1px / 2px patterns: any resampling at 1:1 turns them grey or moiré."""
    w, h = 480, 360
    im = Image.new("RGB", (w, h), "white")
    px = im.load()
    for y in range(h):
        for x in range(w):
            if y < 120:
                on = (x + y) % 2 == 0  # 1px checker
            elif y < 240:
                on = x % 2 == 0 if x < w // 2 else (x // 2) % 2 == 0  # 1px / 2px columns
            else:
                on = y % 2 == 0 if x < w // 2 else (y // 2) % 2 == 0  # 1px / 2px rows
            if on:
                px[x, y] = (0, 0, 0)
    d = ImageDraw.Draw(im)
    for label, xy in [
        ("1px checker", (8, 4)),
        ("1px cols", (8, 124)),
        ("2px cols", (w // 2 + 8, 124)),
        ("1px rows", (8, 244)),
        ("2px rows", (w // 2 + 8, 244)),
    ]:
        x, y = xy
        d.rectangle([x - 3, y - 2, x + 70, y + 12], fill="white")
        d.text(xy, label, fill=(200, 0, 0), font=FONT)
    d.rectangle([0, 0, w - 1, h - 1], outline=(255, 0, 0))  # 1px red frame: visible crop edge
    im.save(OUT / "pixel-grid.png")


def line_study() -> None:
    """Fine hatching and hair-like curves, closer to what an artist inspects."""
    w, h = 1600, 1200
    im = Image.new("RGB", (w, h), (238, 232, 222))
    d = ImageDraw.Draw(im)
    for i in range(0, 260, 3):
        d.arc([300 - i, 200 - i // 2, 1300 + i, 1100 + i // 3], 190, 350, fill=(40, 28, 20), width=1)
    for i in range(0, 400, 4):
        d.line([(100 + i, 900), (300 + i, 1150)], fill=(90, 60, 50), width=1)
    for r in range(10, 200, 6):
        d.ellipse([1150 - r, 650 - r, 1150 + r, 650 + r], outline=(30, 70, 120), width=1)
    d.rectangle([0, 0, w - 1, h - 1], outline=(255, 0, 0), width=2)
    for x in range(0, w, 100):
        d.text((x + 3, 3), str(x), fill=(200, 0, 0), font=FONT)
    for y in range(100, h, 100):
        d.text((3, y + 3), str(y), fill=(200, 0, 0), font=FONT)
    im.save(OUT / "line-study.png")


def exif_orientation() -> None:
    """Pixels stored rotated, EXIF Orientation=6: a correct viewer shows 'UP' upright."""
    w, h = 400, 300
    im = Image.new("RGB", (w, h), (250, 250, 250))
    d = ImageDraw.Draw(im)
    d.polygon([(200, 30), (150, 110), (250, 110)], fill=(30, 120, 60))
    d.rectangle([185, 110, 215, 250], fill=(30, 120, 60))
    d.text((20, 20), "UP / top-left", fill=(0, 0, 0), font=FONT)
    d.rectangle([0, 0, w - 1, h - 1], outline=(255, 0, 0))
    stored = im.transpose(Image.Transpose.ROTATE_90)  # undone by Orientation=6 (rotate 90 CW)
    exif = Image.Exif()
    exif[0x0112] = 6
    stored.save(OUT / "exif-orientation-6.jpg", quality=95, exif=exif.tobytes())


if __name__ == "__main__":
    pixel_grid()
    line_study()
    exif_orientation()
    print("samples written to", OUT)
