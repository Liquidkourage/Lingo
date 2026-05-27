"""Extract LINGO logo -> tight transparent PNG + minimal SVG.

Supports green-screen or baked checkerboard 'fake transparency' backgrounds.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
PNG_OUT = ROOT / "lingo-logo-extracted.png"
SVG_OUT = ROOT / "lingo-logo-extracted.svg"

# Prefer checkerboard source if present, else green-screen source.
SRC_CHECKER = ROOT / "lingo-logo-source-checkerboard.png"
SRC_GREEN = ROOT / "lingo-logo-source.png"


def is_screen_green(r: int, g: int, b: int) -> bool:
    return g >= 160 and r <= 140 and b <= 140 and g > r + 40 and g > b + 40


def is_checkerboard_bg(r: int, g: int, b: int) -> bool:
    """Neutral gray/white squares used as fake transparency in AI exports."""
    if abs(r - g) > 10 or abs(g - b) > 10:
        return False
    return r >= 148  # light gray ~#CCC and white ~#FFF


def key_background(im: Image.Image) -> Image.Image:
    out = im.convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_screen_green(r, g, b) or is_checkerboard_bg(r, g, b):
                px[x, y] = (0, 0, 0, 0)
    return out


def crop_large_word(im: Image.Image) -> Image.Image:
    """For dual-logo green-screen source: keep bottom wordmark only."""
    w, h = im.size
    split = int(h * 0.33)
    return im.crop((0, split, w, h))


def trim_to_logo(im: Image.Image) -> Image.Image:
    alpha = im.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError("No logo pixels found after background removal")
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


def pick_source() -> tuple[Path, bool]:
    if SRC_CHECKER.exists():
        return SRC_CHECKER, False
    if SRC_GREEN.exists():
        return SRC_GREEN, True
    raise SystemExit(f"No source image in {ROOT}")


def main() -> None:
    src, is_green_dual = pick_source()
    keyed = key_background(Image.open(src))
    region = crop_large_word(keyed) if is_green_dual else keyed
    final = trim_to_logo(region)
    final.save(PNG_OUT, optimize=True)

    w, h = final.size
    write_svg(SVG_OUT, PNG_OUT.name, w, h)
    alpha = final.split()[3].getextrema()
    print(f"OK  source={src.name}  png={w}x{h}  alpha={alpha}")


if __name__ == "__main__":
    main()
