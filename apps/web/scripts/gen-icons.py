"""Render the "D." brand mark to raster icons (favicon.ico, apple-icon.png).

Usage: python3 -I scripts/gen-icons.py
Colors: magpie #1E40AF tile, paper D, beak-red dot (same geometry as components/brand/logo.tsx).
"""

from PIL import Image, ImageDraw

MAGPIE = (30, 64, 175, 255)
PAPER = (250, 249, 245, 255)
BEAK = (226, 77, 52, 255)


def render(size, radius_ratio=0.22, pad=0.0):
    s = 1024
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * radius_ratio), fill=MAGPIE)
    # mark geometry on a 32-unit grid, inset so it breathes on the tile
    inset = s * (0.14 + pad)
    u = (s - 2 * inset) / 32

    def p(x, y):
        return (inset + x * u, inset + y * u)

    # D body: x 4..15 straight, then a 12-unit radius half circle
    d.rectangle([p(4, 4), p(15, 28)], fill=PAPER)
    d.pieslice([p(3, 4), p(27, 28)], start=-90, end=90, fill=PAPER)
    # cursor slot
    d.rectangle([p(8, 10), p(11, 22)], fill=MAGPIE)
    # beak dot
    cx, cy = p(27.5, 25)
    r = 3.5 * u
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BEAK)
    return im.resize((size, size), Image.LANCZOS)


render(180, radius_ratio=0.0).save("app/apple-icon.png")
render(256).save("app/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
render(512).save("public/icon-512.png")
render(192).save("public/icon-192.png")
print("ok")
