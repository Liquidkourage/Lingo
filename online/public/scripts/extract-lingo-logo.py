"""Extract large LINGO from green-screen source -> tight transparent PNG + SVG."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
SRC = ROOT / "lingo-logo-source.png"
PNG_OUT = ROOT / "lingo-logo-extracted.png"
SVG_OUT = ROOT / "lingo-logo-extracted.svg"


def is_screen_green(r: int, g: int, b: int) -> bool:
    """Only the flat chroma-key backdrop — not logo pixels."""
    return g >= 160 and r <= 140 and b <= 140 and g > r + 40 and g > b + 40


def chroma_key(im: Image.Image) -> Image.Image:
    out = im.convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_screen_green(r, g, b):
                px[x, y] = (0, 0, 0, 0)
    return out


def crop_large_word(im: Image.Image) -> Image.Image:
    w, h = im.size
    split = int(h * 0.33)
    return im.crop((0, split, w, h))


def trim_to_logo(im: Image.Image) -> Image.Image:
    """Canvas exactly fits opaque logo pixels — no extra margin."""
    alpha = im.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError("No logo pixels found after chroma key")
    return im.crop(bbox)


def write_svg(svg_path: Path, png_name: str, w: int, h: int) -> None:
    svg_path.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="Lingo">
  <image width="{w}" height="{h}" href="{png_name}" />
</svg>
""",
        encoding="utf-8",
    )


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source image: {SRC}")

    keyed = chroma_key(Image.open(SRC))
    bottom = crop_large_word(keyed)
    final = trim_to_logo(bottom)
    final.save(PNG_OUT, optimize=True)

    w, h = final.size
    write_svg(SVG_OUT, PNG_OUT.name, w, h)
    print(f"OK  {PNG_OUT.name}  {w}x{h}  (tight canvas, transparent background only)")


if __name__ == "__main__":
    main()
