"""Generate the Taiwan dot-matrix used by the landing map.

Usage: python3 -I scripts/gen-taiwan-dots.py <ne_10m_admin_0_countries.geojson> <out.bin> [spacing]

Source: Natural Earth 10m admin 0 countries (public domain). Matsu is not part of the
Taiwan polygon in Natural Earth, so its main islands are added as hand-placed points.
Output: little-endian uint16 pairs (x, y) where x = (lon - 118) * 1000, y = (lat - 21.8) * 1000.
"""

import json
import struct
import sys

LON0, LAT0 = 118.0, 21.8
MATSU = [  # (lon, lat): Nangan, Beigan, Juguang (Dongju / Xiju), Dongyin
    (119.94, 26.16), (119.96, 26.15), (119.99, 26.22), (120.01, 26.23),
    (119.98, 25.97), (120.0, 25.95), (120.49, 26.37), (120.5, 26.36),
]


def inside(x, y, ring):
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def main():
    src, out = sys.argv[1], sys.argv[2]
    step = float(sys.argv[3]) if len(sys.argv) > 3 else 0.03
    data = json.load(open(src, encoding="utf-8"))
    polys = []
    for f in data["features"]:
        if f["properties"].get("ADM0_A3") == "TWN":
            polys = [p[0] for p in f["geometry"]["coordinates"]]
    points = []
    for poly in polys:
        xs = [c[0] for c in poly]
        ys = [c[1] for c in poly]
        found = 0
        # a single global lattice (integer indices, no float drift) so islands line up
        for row in range(int((min(ys) - LAT0) / step), int((max(ys) - LAT0) / step) + 2):
            lat = LAT0 + row * step
            offset = step / 2 if row % 2 else 0  # hex-like stagger
            for col in range(int((min(xs) - LON0) / step) - 1, int((max(xs) - LON0) / step) + 2):
                lon = LON0 + col * step + offset
                if inside(lon, lat, poly):
                    points.append((lon, lat))
                    found += 1
        if found == 0:  # tiny islands still get one dot
            points.append((sum(xs) / len(xs), sum(ys) / len(ys)))
    points.extend(MATSU)
    seen = set()
    buf = bytearray()
    for lon, lat in points:
        key = (round((lon - LON0) * 1000), round((lat - LAT0) * 1000))
        if key in seen:
            continue
        seen.add(key)
        buf += struct.pack("<HH", *key)
    open(out, "wb").write(buf)
    print(f"{len(seen)} dots, {len(buf)} bytes")


main()
