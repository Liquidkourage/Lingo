from PIL import Image
import json

mock = Image.open(r"online/public/assets/reference-mockup.png")
W, H = mock.size
assets = r"online/public/assets"

logo_box = (118, 8, 906, 98)
mock.crop(logo_box).save(f"{assets}/display-logo-full.png")

timer_box = (848, 18, 1002, 108)
mock.crop(timer_box).save(f"{assets}/display-timer-ref.png")

tile_box = (292, 168, 372, 248)
mock.crop(tile_box).save(f"{assets}/display-word-tile-ref.png")

stats_box = (48, 248, 976, 318)
mock.crop(stats_box).save(f"{assets}/display-stats-ref.png")

board_box = (48, 318, 976, 558)
mock.crop(board_box).save(f"{assets}/display-board-ref.png")

points = {
    "timerValue": (925, 68),
    "roundValue": (102, 285),
    "ballsValue": (307, 285),
    "multValue": (512, 285),
    "playersValue": (717, 285),
    "submittedValue": (922, 285),
    "badgeCenter": (512, 118),
    "subtitleCenter": (512, 142),
    "wordRowCenter": (512, 208),
    "boardCenter": (512, 430),
}
colors = {k: mock.getpixel(v)[:3] for k, v in points.items()}

layout = {
    "size": [W, H],
    "logo": {"left_pct": logo_box[0] / W * 100, "top_pct": logo_box[1] / H * 100, "width_pct": (logo_box[2] - logo_box[0]) / W * 100},
    "timerValue": {"left_pct": 90.33, "top_pct": 11.83},
    "badge": {"left_pct": 50, "top_pct": 20.52, "width_pct": 28, "height_pct": 4.5},
    "subtitle": {"left_pct": 50, "top_pct": 24.7, "width_pct": 62},
    "wordRow": {"left_pct": 50, "top_pct": 36.17, "width_pct": 39.06, "height_pct": 13.91},
    "stats": {
        "round": {"left_pct": 9.96, "top_pct": 49.57},
        "balls": {"left_pct": 30.0, "top_pct": 49.57},
        "mult": {"left_pct": 50.0, "top_pct": 49.57},
        "players": {"left_pct": 70.0, "top_pct": 49.57},
        "submitted": {"left_pct": 90.04, "top_pct": 49.57},
    },
    "playerBoard": {"left_pct": 50, "top_pct": 75.65, "width_pct": 90.62, "height_pct": 41.74},
    "colors": colors,
}

with open(r"online/public/display-layout.json", "w", encoding="utf-8") as f:
    json.dump(layout, f, indent=2)

print(json.dumps(layout, indent=2))
