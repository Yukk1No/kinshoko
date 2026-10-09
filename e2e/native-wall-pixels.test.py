"""Offline checks for native-wall-pixels.py frozen mode: gates read the token PNG, never the shaded overlay."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from PIL import Image

helper = Path(__file__).with_name("native-wall-pixels.py")
size, shown, selected = (200, 120), [40, 20, 80, 60], [60, 35, 10, 8]

def grid():
    image = Image.new("RGB", size, (255, 255, 255))
    for x in range(size[0]):
        for y in range(size[1]):
            image.putpixel((x, y), (255 if x % 4 >= 2 else 0, 255 if y % 4 >= 2 else 0, x % 2 * 255))
    return image

def blue():
    image = Image.new("RGB", size, (255, 255, 255))
    image.paste((3, 17, 229), (50, 25, 90, 60))
    return image

def shaded(image):
    return image.point(lambda value: round(value * 0.75))

def run(token, overlay):
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        token.save(work / "token.png")
        overlay.save(work / "overlay.png")
        r = subprocess.run([sys.executable, str(helper), "frozen", str(work / "source.png"), str(work / "token.png"), str(work / "overlay.png"), json.dumps(shown), json.dumps(selected), json.dumps(list(size))], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        result = json.loads(r.stdout)
        assert Image.open(work / "source.png").size == tuple(shown[2:])
        return result

result = run(grid(), shaded(grid()))
assert result["sourcePattern"]["red"] >= 8 and result["sourcePattern"]["green"] >= 5, result
assert result["selectedPattern"]["red"] >= 1 and result["selectedPattern"]["green"] >= 1, result
assert result["overlay"]["shadeMatch"] is True and result["overlay"]["shadeWithin3"] == 1.0, result

result = run(blue(), shaded(blue()))
assert result["selectedUniformBlue"] is True, "exact blue is read from the unshaded token PNG"
assert result["overlay"]["selectedUniformBlue"] is False, "the shaded overlay never satisfies exact blue"
assert result["overlay"]["shadeMatch"] is True, result

flat = Image.new("RGB", size, (255, 255, 255))
result = run(grid(), shaded(flat))
assert result["sourcePattern"]["red"] >= 8, "a flat overlay does not hide grid pixels present in the token PNG"
assert result["overlay"]["shadeMatch"] is False and result["overlay"]["sourcePattern"] == {"red": 0, "green": 0}, result

result = run(flat, shaded(flat))
assert result["sourcePattern"] == {"red": 0, "green": 0}, "a flat token PNG fails the grid gate even when the overlay agrees"
print("native-wall-pixels frozen mode: 4 offline cases passed")
