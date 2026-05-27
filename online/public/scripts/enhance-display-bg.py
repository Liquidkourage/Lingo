"""Blend reference atmosphere into the display background plate."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1] / "assets"
BG_IN = ROOT / "lingo-display-waiting-v2-bg.png"
BG_OUT = ROOT / "lingo-display-waiting-v2-bg-rich.png"
REF = Path.home() / "Downloads" / "download-f3157ea6-7bbb-473d-9a6e-e86ce9a86ee5-4040.png"

STAGE_W, STAGE_H = 1024, 575
BLUR_RADIUS = 52
BLEND_OPACITY = 0.36


def crop_reference(ref: Image.Image) -> Image.Image:
    w, h = ref.size
    if w != STAGE_W:
        raise SystemExit(f"Expected reference width {STAGE_W}, got {w}")
    y0 = max(0, (h - STAGE_H) // 2)
    return ref.crop((0, y0, STAGE_W, y0 + STAGE_H))


def top_weight_mask(height: int, width: int) -> np.ndarray:
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, np.newaxis]
    mask = np.clip(1.1 - y * 1.35, 0.18, 1.0)
    return np.repeat(mask, width, axis=1)[..., np.newaxis]


def main() -> None:
    if not REF.exists():
        raise SystemExit(f"Reference image not found: {REF}")

    ref575 = crop_reference(Image.open(REF).convert("RGB"))
    bg = Image.open(BG_IN).convert("RGB")
    atmo = ref575.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))

    bg_arr = np.array(bg, dtype=np.float32)
    atmo_arr = np.array(atmo, dtype=np.float32)
    mask = top_weight_mask(STAGE_H, STAGE_W)

    out = np.clip(bg_arr * (1.0 - BLEND_OPACITY * mask) + atmo_arr * (BLEND_OPACITY * mask), 0, 255)
    BG_OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out.astype(np.uint8)).save(BG_OUT, optimize=True)
    print(f"OK  {BG_OUT.name}  opacity={BLEND_OPACITY}  blur={BLUR_RADIUS}")


if __name__ == "__main__":
    main()
