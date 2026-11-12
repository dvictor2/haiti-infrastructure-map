# Licence of the building files

The files in this folder (`haiti-buildings-*.pmtiles`, `index.json`) are a database of building outlines in Haiti,
derived from the Overture Maps "buildings" theme, release 2026-10-21.0. They are made available under the
**Open Database License (ODbL) 1.0**: https://opendatacommons.org/licenses/odbl/1-0/

You may copy, share and adapt them if you credit the sources and share any adapted database under the same licence.

## Sources to credit

- © OpenStreetMap contributors (ODbL 1.0): https://www.openstreetmap.org/copyright
- Overture Maps Foundation: https://docs.overturemaps.org/attribution/
- Google Open Buildings (CC BY 4.0, also offered under ODbL 1.0): https://sites.research.google/gr/open-buildings/
- Microsoft Global ML Building Footprints (ODbL 1.0): https://github.com/microsoft/GlobalMLBuildingFootprints

## What was changed

Made by `tools/build-buildings.mjs`: only zoom 14 over Haiti is kept, and each building keeps its outline plus
an estimated height and roof colour. The outlines come from the sources; the heights and roof colours are
estimates added here (almost no building in Haiti has a recorded height) and are screening-level only. Buildings
standing on the map's 3D model places are marked so the map can leave them out.
