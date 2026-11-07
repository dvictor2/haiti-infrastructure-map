# Haiti Infrastructure Plan

An interactive 3D map of a national and local infrastructure master plan for Haiti: proposed corridors, trunk highways, bridges and island links, city ring roads (périphériques), local feeder roads, water, and strategic sites.

Plain HTML, CSS and JavaScript. No build step, no API keys. Interface in English, Español, Português, Français and Kreyòl ayisyen (`i18n.js`).

## Run it locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Update the plan data

The plan lives in `source/haitiProjectSpecs.js` (exported from the original Google Earth / KML file). After editing it, rebuild the map data:

```bash
node tools/build-data.mjs --raw     # map data from the drawing as-is
node tools/fix-geometry.mjs         # move routes off the sea and lakes, connect loose ends
node tools/build-data.mjs           # final map data with the fixes applied
node tools/qa-geometry.mjs          # optional: report what still crosses water
```

`build-data` works out categories, departments, lengths, ring stations (Portes), ferry terminals and river bridges. `fix-geometry` uses public elevation data (Mapzen Terrarium on AWS) to find stretches over water; what it changed is listed in `docs/geometry-fixes.md`. The original drawing is never modified.

## Publish

Any static host works. On GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics. Terrain: Mapzen terrain tiles on AWS Open Data. Street map © OpenStreetMap contributors, © CARTO. Department outlines: Natural Earth (public domain). Map engine: MapLibre GL JS. Fonts: OpenFreeMap, Google Fonts (Inter).
