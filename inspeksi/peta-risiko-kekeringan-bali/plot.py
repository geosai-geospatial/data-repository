# Figures for README.md. Needs the PDF (rendered by poppler's pdftoppm) and
# the class previews (*.pgm, 1:8) that diagnose.mjs writes next to its GeoJSON.
#   python3 plot.py <file.pdf> hasil img
import subprocess, sys, tempfile, os
import numpy as np
from PIL import Image, ImageDraw
pdf, res, out = sys.argv[1:4]
FRAME = (58.2, 297.2, 2342.6, 1638.4); PAGE_H = 1683.78; DPI = 25  # 1:8 of 200 dpi
PAL = np.array([[255, 255, 255], [90, 190, 60], [246, 214, 40], [222, 74, 18]], np.uint8)
NAMES = {"B_gradasi_legenda_dE12": "Ambil gradasi, dE 12 (bawaan)", "C_gradasi_legenda_dE40": "Ambil gradasi, dE 40 (maksimum)",
         "D_rona_hue": "Rona (hue) + isi celah"}

def render(dpi, box):  # box in pt: x0, top, w, h (y down)
    s = dpi / 72
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["pdftoppm", "-r", str(dpi), "-x", str(round(box[0] * s)), "-y", str(round(box[1] * s)),
                        "-W", str(round(box[2] * s)), "-H", str(round(box[3] * s)), "-singlefile", pdf, os.path.join(d, "a")], check=True)
        return np.asarray(Image.open(os.path.join(d, "a.ppm")).convert("RGB"))

def titled(a, title):
    im = Image.new("RGB", (a.shape[1], a.shape[0] + 26), "white"); im.paste(Image.fromarray(a), (0, 26))
    ImageDraw.Draw(im).text((6, 7), title, fill="black"); return np.asarray(im)

def classes(name):
    return PAL[np.asarray(Image.open(os.path.join(res, name + ".pgm")))]

# 1. Whole island: the map, then three runs.
page = render(DPI, (FRAME[0], PAGE_H - FRAME[3], FRAME[2] - FRAME[0], FRAME[3] - FRAME[1]))
panels = [titled(page, "Peta asli (PDF)")] + [titled(classes(k), v) for k, v in NAMES.items()]
h = min(p.shape[0] for p in panels); w = min(p.shape[1] for p in panels)
panels = [p[:h, :w] for p in panels]
grid = np.concatenate([np.concatenate(panels[:2], 1), np.concatenate(panels[2:], 1)], 0)
Image.fromarray(grid).save(os.path.join(out, "perbandingan.png"), optimize=True)

# 2. Legend colour vs. map pixels of the same hue: one row per class break.
bar = render(200, (72.0, 1600.0, 434.9, 12.0))[6]
m = render(200, (FRAME[0], PAGE_H - FRAME[3], FRAME[2] - FRAME[0], FRAME[3] - FRAME[1])).reshape(-1, 3)[::37].astype(float)
def hsv(a):
    a = a / 255; mx = a.max(-1); mn = a.min(-1); d = mx - mn; dd = np.where(d > 0, d, 1); r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    return np.where(d > 0, h, -1), np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0), mx
mh, ms, mv = hsv(m); bh, _, _ = hsv(bar.astype(float))
img = Image.new("RGB", (760, 4 * 70 + 30), "white"); dr = ImageDraw.Draw(img)
dr.text((8, 8), "Kiri: warna di legenda. Kanan: piksel peta dengan rona (hue) yang sama, dari lereng gelap ke terang.", fill="black")
for i, t in enumerate((0.50, 0.58, 0.62, 0.70)):
    pos = t / 0.9 if t < 0.3 else 1 / 3 + (t - 0.3) / 0.9 if t < 0.6 else 2 / 3 + (t - 0.6) / 1.2  # bar: three equal thirds
    bx = min(len(bar) - 1, round(pos * len(bar)))
    hue = bh[bx]; sel = (np.abs(mh - hue) < 0.5) & (ms > 0.35)
    px = m[sel][np.argsort(mv[sel])]; y = 30 + i * 70
    dr.rectangle((8, y, 108, y + 56), fill=tuple(int(v) for v in bar[bx])); dr.text((116, y + 6), f"indeks {t:.2f}\nrona {hue:.0f}°", fill="black")
    for j, q in enumerate(np.linspace(0.02, 0.98, 10)):
        c = px[int(q * (len(px) - 1))] if len(px) else (255, 255, 255)
        dr.rectangle((210 + j * 54, y, 258 + j * 54, y + 56), fill=tuple(int(v) for v in c))
img.save(os.path.join(out, "warna_legenda_vs_peta.png"), optimize=True)
