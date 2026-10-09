"""T17 native evidence: bounded frozen-source pixels and the owned clipboard image."""
import json
from pathlib import Path
import sys
import time
from PIL import Image, ImageGrab

mode, output = sys.argv[1:3]
output = Path(output)
if mode == "frozen":
    # Gates read the token-bound frozen PNG served by the product. The capture WebView screenshot
    # carries the product's 25% selection shade, so it is only compared against the shaded frozen pixels.
    token_path, overlay_path = sys.argv[3:5]
    shown, selected, expected = map(json.loads, sys.argv[5:8])
    image = Image.open(token_path).convert("RGB")
    assert list(image.size) == list(expected), (image.size, expected)
    overlay = Image.open(overlay_path).convert("RGB")
    assert all(e <= actual <= e+1 for actual,e in zip(overlay.size,expected)), (overlay.size, expected)
    raster = list(overlay.size)
    overlay = overlay.crop((0,0,*expected))
    def crop(im,r):
        x,y,width,height = r
        assert x >= 0 and y >= 0 and width > 0 and height > 0 and x+width <= im.width and y+height <= im.height
        return im.crop((x,y,x+width,y+height))
    def pattern(im):
        red = [im.getpixel((x,im.height//2))[0] for x in range(im.width)]
        green = [im.getpixel((im.width//2,y))[1] for y in range(im.height)]
        return {"red":sum(a<128<=b for a,b in zip(red,red[1:])), "green":sum(a<128<=b for a,b in zip(green,green[1:]))}
    def corners(im):
        return [im.getpixel((0,0)),im.getpixel((im.width-1,0)),im.getpixel((0,im.height-1)),im.getpixel((im.width-1,im.height-1))]
    source, selection = crop(image,shown), crop(image,selected)
    shown_overlay, selected_overlay = crop(overlay,shown), crop(overlay,selected)
    deltas = [max(abs(round(f*0.75)-o) for f,o in zip(frozen_pixel,overlay_pixel)) for frozen_pixel,overlay_pixel in zip(source.getdata(),shown_overlay.getdata())]
    within = sum(delta <= 3 for delta in deltas)/len(deltas)
    source.save(output)
    shown_overlay.save(output.with_name(output.stem+"-overlay"+output.suffix))
    result={"token":{"path":token_path,"size":list(image.size)},"webdriverRaster":raster,"screen":list(overlay.size),"shown":shown,"selected":selected,"sourcePattern":pattern(source),"selectedPattern":pattern(selection),"selectedCorners":corners(selection),"selectedUniformBlue":all(pixel==(3,17,229) for pixel in selection.getdata()),"overlay":{"path":overlay_path,"sourcePattern":pattern(shown_overlay),"selectedPattern":pattern(selected_overlay),"selectedCorners":corners(selected_overlay),"selectedUniformBlue":all(pixel==(3,17,229) for pixel in selected_overlay.getdata()),"shadeWithin3":within,"shadeMaxDelta":max(deltas),"shadeMatch":within>=0.99},"artifact":str(output)}
elif mode == "clipboard":
    image = ImageGrab.grabclipboard()
    assert isinstance(image,Image.Image), "The synthetic owned clipboard must contain an image"
    image = image.convert("RGBA")
    image.save(output)
    result={"size":image.size,"uniformBlueRGBA":all(pixel==(3,17,229,255) for pixel in image.getdata()),"corners":[image.getpixel((0,0)),image.getpixel((image.width-1,0)),image.getpixel((0,image.height-1)),image.getpixel((image.width-1,image.height-1))],"artifact":str(output),"observedAtUnix":int(time.time()*1000)}
else:
    raise ValueError(mode)
print(json.dumps(result))
