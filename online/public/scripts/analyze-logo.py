from PIL import Image

im = Image.open("online/public/assets/lingo-display-waiting-v2-logo.png").convert("RGBA")
w, h = im.size
px = im.load()

def region_avg(x0, x1, y0, y1, min_a=140):
    rs, gs, bs, ns = [], [], [], 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b, a = px[x, y]
            if a >= min_a:
                rs.append(r)
                gs.append(g)
                bs.append(b)
                ns += 1
    if not ns:
        return None, 0
    return (sum(rs) // ns, sum(gs) // ns, sum(bs) // ns), ns

regions = {
    "L_face_upper": (35, 55, 18, 38),
    "L_face_lower": (35, 55, 38, 58),
    "L_gold_bezel": (22, 68, 52, 72),
    "L_dark_outer": (10, 22, 30, 50),
    "center_blue_glow": (280, 360, 78, 98),
    "G_face_upper": (300, 330, 18, 38),
    "O_face_upper": (520, 560, 18, 38),
}
for k, v in regions.items():
    c, n = region_avg(*v)
    print(k, c, "n", n)

print("bbox", im.getbbox())
total = 0
sy = 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a > 100:
            total += a
            sy += y * a
print("y_com", sy / total if total else None)
