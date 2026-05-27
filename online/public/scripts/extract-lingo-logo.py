"""Extract LINGO logo -> tight transparent PNG + minimal SVG.

Source priority: black background > checkerboard > green screen.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
PNG_OUT = ROOT / "lingo-logo-extracted.png"
SVG_OUT = ROOT / "lingo-logo-extracted.svg"

SRC_BLACK = ROOT / "lingo-logo-source-black.png"
SRC_CHECKER = ROOT / "lingo-logo-source-checkerboard.png"
SRC_GREEN = ROOT / "lingo-logo-source.png"

# Darkest navy in logo stays above this (sum of RGB channels).
BLACK_LUM_THRESHOLD = 42


def is_black_bg(r: int, g: int, b: int) -> bool:
    return (r + g + b) <= BLACK_LUM_THRESHOLD and b <= 28


def source_is_black(im: Image.Image) -> bool:
    """Skip misnamed sources that are still checkerboard."""
    px = im.convert("RGB").load()
    w, h = im.size
    samples = [px[8, 8], px[w - 9, 8], px[w // 2, h // 2]]
    checker = sum(1 for r, g, b in samples if is_checkerboard_bg(r, g, b))
    return checker < 2


def is_screen_green(r: int, g: int, b: int) -> bool:
    return g >= 160 and r <= 140 and b <= 140 and g > r + 40 and g > b + 40


def is_checkerboard_bg(r: int, g: int, b: int) -> bool:
    if abs(r - g) > 10 or abs(g - b) > 10:
        return False
    return r >= 148


def key_background(im: Image.Image, mode: str) -> Image.Image:
    out = im.convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            remove = False
            if mode == "black":
                remove = is_black_bg(r, g, b)
            elif mode == "checker":
                remove = is_checkerboard_bg(r, g, b)
            else:
                remove = is_screen_green(r, g, b)
            if remove:
                px[x, y] = (0, 0, 0, 0)
    return out


def crop_large_word(im: Image.Image) -> Image.Image:
    w, h = im.size
    return im.crop((0, int(h * 0.33), w, h))


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


def pick_source() -> tuple[Path, str, bool]:
    if SRC_BLACK.exists():
        probe = Image.open(SRC_BLACK)
        if source_is_black(probe):
            return SRC_BLACK, "black", False
    if SRC_GREEN.exists():
        return SRC_GREEN, "green", True
    if SRC_CHECKER.exists():
        return SRC_CHECKER, "checker", False
    raise SystemExit(f"No source image in {ROOT}")


def main() -> None:
    src, mode, dual = pick_source()
    keyed = key_background(Image.open(src), mode)
    region = crop_large_word(keyed) if dual else keyed
    final = trim_to_logo(region)
    final.save(PNG_OUT, optimize=True)

    w, h = final.size
    write_svg(SVG_OUT, PNG_OUT.name, w, h)
    print(f"OK  source={src.name}  mode={mode}  png={w}x{h}  alpha={final.split()[3].getextrema()}")


if __name__ == "__main__":
    main()
