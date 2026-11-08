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

## Development layers

The **Development** tab shows existing infrastructure from open data (OpenStreetMap, Kontur population, GEM faults, TeleGeography cables) and screening-level proposals for energy, water, sewage, agriculture, housing, investment hubs, connectivity, health and hazards. Data sources and every siting rule are in [`docs/development-method.md`](docs/development-method.md).

```bash
sh tools/fetch-sources.sh
node tools/build-dev.mjs
```

## Plan in numbers and trips

`tools/build-numbers.mjs` estimates the construction mix (at grade, mountain, viaduct, tunnel) of every route with the same method as the in-app Engineering & cost card, and counts how many people live near the network. It writes `data/numbers.json`, which feeds the **Plan in numbers** page and the tunnel/bridge totals in **Plan a trip**. Re-run it after the plan changes:

```bash
node tools/build-numbers.mjs
```

The trip planner builds its road graph in the browser from `data/plan.geojson`; times use the design speeds in `ENG` (app.js), not today's roads.

## Publish

Any static host works. On GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics. Terrain: Mapzen terrain tiles on AWS Open Data. Street map © OpenStreetMap contributors, © CARTO. Department outlines: Natural Earth (public domain). Map engine: MapLibre GL JS. Fonts: OpenFreeMap, Google Fonts (Inter).
