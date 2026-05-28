from PIL import Image

im = Image.open("online/public/assets/lingo-display-waiting-v2-logo.png").convert("RGBA")
px = im.load()
w, h = im.size

# brightest face pixels
bright = []
gold = []
dark = []
blue = []
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a < 180:
            continue
        lum = r + g + b
        if lum > 680 and r > 200:
            bright.append((r, g, b))
        elif r > 180 and g > 120 and b < 80:
            gold.append((r, g, b))
        elif lum < 80:
            dark.append((r, g, b))
        elif b > r + 20 and b > 100:
            blue.append((r, g, b))

def avg(lst):
    if not lst:
        return None
    n = len(lst)
    return tuple(sum(c[i] for c in lst) // n for i in range(3))

print("bright face", avg(bright[:5000]), "count", len(bright))
print("gold", avg(gold[:5000]), "count", len(gold))
print("dark", avg(dark[:5000]), "count", len(dark))
print("blue", avg(blue[:5000]), "count", len(blue))

# horizontal extent per scanline at y=45
row = [(x, px[x, 45][:3]) for x in range(w) if px[x, 45][3] > 100]
print("opaque span y45", row[0][0] if row else None, row[-1][0] if row else None, "count", len(row))
