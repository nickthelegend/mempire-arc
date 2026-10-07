#!/usr/bin/env python3
"""Slice generated grid sheets into individual transparent PNGs.

Coins/icons are generated on solid black in an even grid. We cut each cell,
auto-crop to the drawn subject, key out the black surround, and write to
app/public/art/.
"""
import os
import sys
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, "generated")
OUT = os.path.abspath(os.path.join(HERE, "..", "app", "public", "art"))
os.makedirs(OUT, exist_ok=True)

# Sheet reading order must match the prompt's stated row order.
COIN_ORDER = [
    "doggo", "wifhat", "popkat", "peng",
    "frg", "mooncat", "rkt", "chad",
    "bbwhale", "rugproof", "gmi", "ser",
]
ICON_ORDER = ["tank", "swarm", "ranged", "splash", "support", "spell"]
TAB_ORDER = ["arena", "cards", "deck", "empire"]


def key_black(img: Image.Image, thresh: int = 42, feather: float = 0.8) -> Image.Image:
    """Alpha = 0 where the pixel is near-black. Feathered so edges stay clean."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            lum = max(r, g, b)
            if lum <= thresh:
                ap[x, y] = 0
            elif lum < thresh * 2:
                ap[x, y] = int(255 * (lum - thresh) / thresh)
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    img.putalpha(alpha)
    return img


def key_green(img: Image.Image, feather: float = 0.7) -> Image.Image:
    """Drop a bright-green key screen. Used where the art is itself dark."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if g > 140 and g > r * 1.6 and g > b * 1.6:
                ap[x, y] = 0
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    img.putalpha(alpha)
    return img


def autocrop(img: Image.Image, pad: int = 4) -> Image.Image:
    bbox = img.split()[-1].getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(img.width, x1 + pad); y1 = min(img.height, y1 + pad)
    return img.crop((x0, y0, x1, y1))


def square(img: Image.Image, size: int) -> Image.Image:
    """Pad to square, then resize — keeps circles circular."""
    side = max(img.width, img.height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def slice_sheet(path: str, cols: int, rows: int, names: list[str], size: int, prefix: str):
    sheet = Image.open(path).convert("RGBA")
    cw, ch = sheet.width // cols, sheet.height // rows
    written = []
    for i, name in enumerate(names):
        r, c = divmod(i, cols)
        if r >= rows:
            break
        cell = sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
        cell = square(autocrop(key_black(cell)), size)
        out = os.path.join(OUT, f"{prefix}{name}.png")
        cell.save(out)
        written.append(f"{prefix}{name}.png")
    return written


def trim_logo(path: str, out_name: str, max_w: int = 1100):
    img = key_black(Image.open(path).convert("RGBA"), thresh=30, feather=0.6)
    img = autocrop(img, pad=8)
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)
    img.save(os.path.join(OUT, out_name))
    return f"{out_name} {img.size}"


def key_out(path: str, out_name: str, size: int, green: bool = False):
    img = Image.open(path).convert("RGBA")
    img = key_green(img) if green else key_black(img)
    img = square(autocrop(img), size)
    img.save(os.path.join(OUT, out_name))
    return out_name


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "tabs"):
        p = os.path.join(GEN, "tab_icons.png")
        if os.path.exists(p):
            print("tabs:", slice_sheet(p, 2, 2, TAB_ORDER, 128, "tab_"))
    if what in ("all", "avatar"):
        p = os.path.join(GEN, "avatar_guest.png")
        if os.path.exists(p):
            print("avatar:", key_out(p, "avatar_guest.png", 192, green=True))
    if what in ("all", "coins"):
        p = os.path.join(GEN, "coin_sheet.png")
        if os.path.exists(p):
            print("coins:", slice_sheet(p, 4, 3, COIN_ORDER, 256, "coin_"))
    if what in ("all", "icons"):
        p = os.path.join(GEN, "icon_sheet.png")
        if os.path.exists(p):
            print("icons:", slice_sheet(p, 3, 2, ICON_ORDER, 128, "icon_"))
    if what in ("all", "logo"):
        p = os.path.join(GEN, "logo_wordmark.png")
        if os.path.exists(p):
            print("logo:", trim_logo(p, "logo.png"))
