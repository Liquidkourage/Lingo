"""Extract large LINGO from green-screen Gemini image -> transparent PNG + SVG."""
from __future__ import annotations

import base64
from pathlib import Path

from PIL import Image

SRC = Path(
    r"C:\Users\liqui\.cursor\projects\c-Users-liqui-OneDrive-Documents-Lingo\assets"
    r"\c__Users_liqui_AppData_Roaming_Cursor_User_workspaceStorage_c454467f8932b26cc76bed81a76e4d95_images_Gemini_Generated_Image_94jvq194jvq194jv-cdb00cdc-f8b6-454a-ac64-2ba835669f01.png"
)
OUT_DIR = Path(__file__).resolve().parents[1] / "assets"
PNG_OUT = OUT_DIR / "lingo-logo-extracted.png"
SVG_OUT = OUT_DIR / "lingo-logo-extracted.svg"

MIN_PAD = 56


def is_green(r: int, g: int, b: int) -> bool:
    return g > 140 and g > r + 40 and g > b + 40


def chroma_key(im: Image.Image) -> Image.Image:
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_green(r, g, b):
                px[x, y] = (r, g, b, 0)
            elif g > max(r, b) + 20:
                spill = min(1.0, (g - max(r, b)) / 120)
                px[x, y] = (r, g, b, int(a * (1 - spill * 0.85)))
    return rgba


def find_large_word_crop(im: Image.Image) -> tuple[int, int, int, int]:
    w, h = im.size
    split = int(h * 0.42)
    bottom = im.crop((0, split, w, h))
    alpha = bottom.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError("No opaque pixels found in bottom crop")
    x0, y0, x1, y1 = bbox
    pad = MIN_PAD
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(bottom.width, x1 + pad)
    y1 = min(bottom.height, y1 + pad)
    return (x0, split + y0, x1, split + y1)


def ensure_min_padding(im: Image.Image, min_pad: int = MIN_PAD) -> tuple[Image.Image, int, int]:
    """Add transparent border so opaque content has min_pad on every side."""
    w, h = im.size
    alpha = im.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        return im, 0, 0
    x0, y0, x1, y1 = bbox
    add_left = max(0, min_pad - x0)
    add_top = max(0, min_pad - y0)
    add_right = max(0, min_pad - (w - x1))
    add_bottom = max(0, min_pad - (h - y1))
    if not any((add_left, add_top, add_right, add_bottom)):
        return im, 0, 0
    canvas = Image.new("RGBA", (w + add_left + add_right, h + add_top + add_bottom), (0, 0, 0, 0))
    canvas.paste(im, (add_left, add_top))
    return canvas, add_left, add_top


def write_svg(png_path: Path, svg_path: Path, img_w: int, img_h: int, margin: int = MIN_PAD) -> None:
    canvas_w = img_w + margin * 2
    canvas_h = img_h + margin * 2
    ox = margin
    oy = margin
    href = png_to_svg_data_uri(png_path)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {canvas_w} {canvas_h}" width="{canvas_w}" height="{canvas_h}" role="img" aria-label="Lingo" preserveAspectRatio="xMidYMid meet">
  <image x="{ox}" y="{oy}" width="{img_w}" height="{img_h}" href="{href}" preserveAspectRatio="xMidYMid meet" />
</svg>
"""
    svg_path.write_text(svg, encoding="utf-8")


def png_to_svg_data_uri(png_path: Path) -> str:
    data = base64.b64encode(png_path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{data}"


def main() -> None:
    im = Image.open(SRC)
    keyed = chroma_key(im)
    crop = find_large_word_crop(keyed)
    extracted = keyed.crop(crop)
    extracted, _, _ = ensure_min_padding(extracted, MIN_PAD)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    extracted.save(PNG_OUT, optimize=True)
    w, h = extracted.size
    write_svg(PNG_OUT, SVG_OUT, w, h, margin=MIN_PAD)
    alpha = extracted.split()[3]
    print(f"crop={crop} png={w}x{h} bbox={alpha.getbbox()} canvas={w + MIN_PAD * 2}x{h + MIN_PAD * 2}")
    print(f"png={PNG_OUT}")
    print(f"svg={SVG_OUT}")


if __name__ == "__main__":
    main()
