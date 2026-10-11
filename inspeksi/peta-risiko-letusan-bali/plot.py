# Draws extracted GeoJSON (blue) over the Natural Earth coastline of
# Indonesia from public/data/basemap.json (red), in longitude/latitude.
#   python3 plot.py basemap.json right.geojson right.png wrong.geojson wrong.png
import json, sys
from PIL import Image, ImageDraw
base = json.load(open(sys.argv[1]))
def draw(gj, out, box, title):
    W = 1200; x0, y0, x1, y1 = box; H = int(W * (y1 - y0) / (x1 - x0))
    im = Image.new("RGB", (W, H + 30), "white"); d = ImageDraw.Draw(im)
    P = lambda lon, lat: ((lon - x0) / (x1 - x0) * W, 30 + (y1 - lat) / (y1 - y0) * H)
    for c in base["countries"]:
        if c["iso"] != "IDN": continue
        for r in c["rings"]:
            pts = [P(r[i] / 1000, r[i + 1] / 1000) for i in range(0, len(r), 2)]
            if len(pts) > 1: d.line(pts + [pts[0]], fill=(220, 30, 30), width=2)
    for f in json.load(open(gj))["features"]:
        g = f["geometry"]; t = g["type"]
        if t == "Point": x, y = P(*g["coordinates"]); d.ellipse((x-2, y-2, x+2, y+2), fill=(0, 90, 200)); continue
        lines = {"LineString": [g["coordinates"]], "MultiLineString": g["coordinates"], "Polygon": g["coordinates"], "MultiPolygon": [r for p in g["coordinates"] for r in p]}[t]
        for l in lines:
            if len(l) > 1: d.line([P(*c) for c in l], fill=(0, 90, 200), width=1)
    d.text((8, 8), title + "   (red = Natural Earth coast, blue = extracted)", fill="black")
    im.save(out)
draw(sys.argv[2], sys.argv[3], (114.2, -9.0, 115.9, -7.9), "Correct control points")
draw(sys.argv[4], sys.argv[5], (113.8, -9.3, 116.3, -5.9), "Y typed in 30 km steps")
