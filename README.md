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

`build-data` works out categories, departments, lengths, ring stations (Portes), ferry terminals and river bridges. `fix-geometry` uses public elevation data (Mapzen Terrarium on AWS) and the OpenStreetMap coastline (which catches shallow bays such as Jacmel's) to find stretches over water; a coastline fix is kept only when it is clearly better and never moves a road onto another island; what it changed is listed in `docs/geometry-fixes.md`. The original drawing is never modified.

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

For comparison, each trip is also routed on **today's roads** with [OSRM](https://project-osrm.org/) on the FOSSGIS server (`routing.openstreetmap.de`, OpenStreetMap data). It is a free shared service meant for light use.

## Hazards

The Development tab's **Hazards** section shows:

- **Hurricane tracks**: every North Atlantic storm since 1950 that passed within 250 km of Haiti, from NOAA NCEI IBTrACS v04r01 (public domain). Built by `node tools/build-hazards.mjs` → `data/storms.json`. Active storms and their forecast cones come live from the NOAA National Hurricane Center map service.
- **Earthquakes**: magnitude 4.5 and above since 1900 around Hispaniola, fetched live from the USGS ComCat catalog.

## Airports

Existing airfields (OpenStreetMap) and screening-level airport proposals: one regional airport per department, island strips paved, a national cargo & backup airport, and new airports where people live far from any paved runway. Rules in [`docs/development-method.md`](docs/development-method.md); built by `node tools/build-airports.mjs`.

## 3D up close

Tilt the map (the **3D** button) to see the real terrain. A card's **3D view** button tilts over the place and slowly circles it. Today's buildings rise in 3D at street zoom, on the photo and on the street map, across the whole country: every building mapped by OpenStreetMap, Google and Microsoft (gathered by Overture Maps), cut into `data/buildings/` by `node tools/build-buildings.mjs`. Their outlines are real; their heights and roof colours are estimates (almost no building in Haiti has a recorded height), so treat them as screening-level. Where a plan line passes behind buildings it continues as a row of dots. With 3D off, the street map shows the outlines flat. National routes carry gentle flow pulses. **Fly along** goes low and close over the scenery, with a label while the route passes through a base tunnel found by the Engineering card. Hand-made block models of plan objects (stations, airports, moving trains…) were tried and removed because they looked crude; realistic models, if wanted, should come from proper 3D artwork.

**Real 3D models.** Five places use models made by 3D artists (CC0 from 3DAssets.dev, CC BY 4.0 from Sketchfab; see `ASSET_CREDITS.md`): Gonaïves · Porte Saint-Marc station with a train that arrives, waits and leaves; the new national airport near Petite-Rivière-de-l'Artibonite with a painted runway and an A320 taking off; a wind farm east of Port-au-Prince with turning blades; a solar block near Gonaïves; and a container ship sailing in and out of Port-au-Prince harbour. `models3d.js` and three.js are fetched only when the map is zoomed in near one of them, each place loads its own files only when near, and nothing is drawn below zoom 14. A card's **3D view** button frames the models.

## Map engine

MapLibre GL JS 5 with the globe projection: a first visit opens on the whole Earth and swoops down to Haiti; the map flattens as you zoom in.

## Publish

Any static host works. On GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics. Terrain: Mapzen terrain tiles on AWS Open Data. Street map: drawn in the page from OpenStreetMap data served by OpenFreeMap (© OpenStreetMap contributors, ODbL). Buildings (`data/buildings/`): © OpenStreetMap contributors, Overture Maps Foundation, Google Open Buildings (CC BY 4.0), Microsoft; the building files are a database derived from those sources and are shared under the Open Database License (ODbL 1.0), see `data/buildings/LICENSE.md`; heights and roof colours are estimates; read with PMTiles. Department outlines: Natural Earth (public domain). Map engine: MapLibre GL JS. 3D models: three.js, models from 3DAssets.dev (CC0) and Sketchfab artists (CC BY 4.0), see `ASSET_CREDITS.md`. Fonts: OpenFreeMap, Google Fonts (Inter).
