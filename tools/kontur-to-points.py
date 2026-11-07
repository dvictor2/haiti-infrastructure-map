"""Converts the Kontur population GeoPackage (H3 hexagons, EPSG:3857) to [lon, lat, people] points."""
import sqlite3, struct, math, json, sys
src, dst = sys.argv[1], sys.argv[2]
db = sqlite3.connect(src)
out = []
for blob, pop in db.execute("select geom, population from population"):
    flags = blob[3]
    fmt = '<4d' if flags & 1 else '>4d'
    minx, maxx, miny, maxy = struct.unpack(fmt, blob[8:40])  # envelope of the hexagon
    x, y = (minx + maxx) / 2, (miny + maxy) / 2
    lon = x / 6378137 * 180 / math.pi
    lat = (2 * math.atan(math.exp(y / 6378137)) - math.pi / 2) * 180 / math.pi
    out.append([round(lon, 5), round(lat, 5), pop])
json.dump(out, open(dst, 'w'))
print(len(out), 'hexagons,', round(sum(p for *_, p in out)), 'people')
