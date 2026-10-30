"""Render the vAPI Desktop app icon from the brand-kit mark.

The mark is nine rectangles (apps/web/public/branding/kit/logos/vapi-mark-*.svg), so it is drawn
directly. The tile follows Apple's macOS icon template: an 824 px rounded square on a 1024 canvas.
Run: python3 -I apps/desktop/scripts/make-icon.py  (writes resources/icon.png and resources/icon.icns)
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

INK = "#111111"
PAPER = "#fafafa"
# x, y, width, height, fill — from vapi-mark-color-dark.svg (743 x 659 viewBox)
MARK = [
    (1, 1, 92, 219, "#ff7300"),
    (93, 1, 37, 219, "#ff337c"),
    (130, 1, 18, 219, "#c3ff3d"),
    (521, 1, 221, 219, PAPER),
    (123, 220, 52, 219, "#97efff"),
    (175, 220, 26, 219, "#0041eb"),
    (201, 220, 19, 219, "#8a37fb"),
    (401, 220, 221, 219, "#0041eb"),
    (281, 439, 221, 219, PAPER),
]
MARK_W, MARK_H = 743, 659

SCALE = 4  # supersample for smooth tile corners
CANVAS = 1024
TILE = 824
RADIUS = 185  # Apple template corner radius for an 824 px tile
MARK_WIDTH = 500


def render() -> Image.Image:
    size = CANVAS * SCALE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    inset = (CANVAS - TILE) // 2 * SCALE
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset), radius=RADIUS * SCALE, fill=INK
    )
    unit = MARK_WIDTH * SCALE / MARK_W
    left = (size - MARK_W * unit) / 2
    top = (size - MARK_H * unit) / 2
    for x, y, w, h, fill in MARK:
        draw.rectangle(
            (left + x * unit, top + y * unit, left + (x + w) * unit - 1, top + (y + h) * unit - 1),
            fill=fill,
        )
    return image.resize((CANVAS, CANVAS), Image.LANCZOS)


def main() -> None:
    out = Path(sys.argv[0]).resolve().parent.parent / "resources"
    out.mkdir(exist_ok=True)
    icon = render()
    icon.save(out / "icon.png")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            icon.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
            icon.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out / "icon.icns")], check=True)
    print(f"wrote {out / 'icon.png'} and {out / 'icon.icns'}")


if __name__ == "__main__":
    main()
