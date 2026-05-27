"""Strip UI from lingo-display-waiting-v2.png, leaving only the stage background."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parents[1] / "assets"
SRC = ASSETS / "lingo-display-waiting-v2.png"
OUT = ASSETS / "lingo-display-waiting-v2-bg.png"

SIDE_KEEP = 78  # px of left/right edge beams to preserve from source


def build_mask(size: tuple[int, int]) -> Image.Image:
    w, h = size
    mask = Image.new("L", size, 255)
    draw = ImageDraw.Draw(mask)

    # Keep only the outer beam strips; remove all center UI.
    draw.rectangle((0, 0, SIDE_KEEP, h), fill=0)
    draw.rectangle((w - SIDE_KEEP, 0, w, h), fill=0)

    return mask.filter(ImageFilter.GaussianBlur(radius=6))


def main() -> None:
    img = Image.open(SRC).convert("RGB")
    w, h = img.size
    mask_img = build_mask(img.size)

    plate = img.filter(ImageFilter.GaussianBlur(radius=64))
    result = Image.composite(plate, img, mask_img)

    result.save(OUT, optimize=True)
    print(f"Wrote {OUT} ({w}x{h})")


if __name__ == "__main__":
    main()
