"""Extract large LINGO from green-screen source -> transparent PNG + minimal SVG."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
SRC = ROOT / "lingo-logo-source.png"
PNG_OUT = ROOT / "lingo-logo-extracted.png"
SVG_OUT = ROOT / "lingo-logo-extracted.svg"

PAD = 48


def is_green(r: int, g: int, b: int) -> bool:
    return g > 130 and g > r + 35 and g > b + 35


def chroma_key(im: Image.Image) -> Image.Image:
    out = im.convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_green(r, g, b):
                px[x, y] = (0, 0, 0, 0)
            elif g > max(r, b) + 15:
                spill = min(1.0, (g - max(r, b)) / 100)
                px[x, y] = (r, g, b, int(a * (1 - spill * 0.9)))
    return out


def crop_large_word(im: Image.Image) -> Image.Image:
    """Keep only the bottom LINGO (below ~40% height)."""
    w, h = im.size
    return im.crop((0, int(h * 0.40), w, h))


def trim_and_pad(im: Image.Image, pad: int = PAD) -> Image.Image:
    """Tight crop to opaque pixels, then equal transparent padding on all sides."""
    alpha = im.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError("No logo pixels found after chroma key")
    tight = im.crop(bbox)
    tw, th = tight.size
    canvas = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    canvas.paste(tight, (pad, pad))
    return canvas


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
    final = trim_and_pad(bottom, PAD)
    final.save(PNG_OUT, optimize=True)

    w, h = final.size
    write_svg(SVG_OUT, PNG_OUT.name, w, h)

    bbox = final.split()[3].getbbox()
    print(f"OK  png={PNG_OUT.name}  {w}x{h}  content_bbox={bbox}")
    print(f"    svg={SVG_OUT.name}  ({SVG_OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
