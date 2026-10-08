"""T17 native evidence: bounded frozen-source pixels and the owned clipboard image."""
import io
import json
from pathlib import Path
import sys
import time
from PIL import Image, ImageGrab

mode, output = sys.argv[1:3]
output = Path(output)
if mode == "frozen":
    image = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
    shown, selected, expected = map(json.loads, sys.argv[3:6])
    assert all(e <= actual <= e+1 for actual,e in zip(image.size,expected)), (image.size, expected)
    raster = list(image.size)
    image = image.crop((0,0,*expected))
    def crop(r):
        x,y,width,height = r
        assert x >= 0 and y >= 0 and width > 0 and height > 0 and x+width <= image.width and y+height <= image.height
        return image.crop((x,y,x+width,y+height))
    source, selection = crop(shown), crop(selected)
    def pattern(im):
        red = [im.getpixel((x,im.height//2))[0] for x in range(im.width)]
        green = [im.getpixel((im.width//2,y))[1] for y in range(im.height)]
        return {"red":sum(a<128<=b for a,b in zip(red,red[1:])), "green":sum(a<128<=b for a,b in zip(green,green[1:]))}
    source.save(output)
    result={"webdriverRaster":raster,"screen":image.size,"shown":shown,"selected":selected,"sourcePattern":pattern(source),"selectedPattern":pattern(selection),"selectedCorners":[selection.getpixel((0,0)),selection.getpixel((selection.width-1,0)),selection.getpixel((0,selection.height-1)),selection.getpixel((selection.width-1,selection.height-1))],"selectedUniformBlue":all(pixel==(3,17,229) for pixel in selection.getdata()),"artifact":str(output)}
elif mode == "clipboard":
    image = ImageGrab.grabclipboard()
    assert isinstance(image,Image.Image), "The synthetic owned clipboard must contain an image"
    image = image.convert("RGBA")
    image.save(output)
    result={"size":image.size,"corners":[image.getpixel((0,0)),image.getpixel((image.width-1,0)),image.getpixel((0,image.height-1)),image.getpixel((image.width-1,image.height-1))],"artifact":str(output),"observedAtUnix":int(time.time()*1000)}
else:
    raise ValueError(mode)
print(json.dumps(result))
