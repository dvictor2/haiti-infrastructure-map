# Development layers: data and method

The **Development** tab adds two kinds of information to the map:

- **Existing** infrastructure, taken from open data as-is.
- **Proposed** sites, placed by simple rules that anyone can check and change in `tools/build-dev.mjs`.

Proposals are screening-level ideas to start a conversation. They are not feasibility or engineering studies, and every one of them needs field verification.

## Data

| What | Source | Licence |
| :-- | :-- | :-- |
| Population (11.7 M, 2023, 400 m hexagons) | Kontur Population, built from building footprints | CC BY 4.0 |
| 1 km land grid used for terrain analysis | WorldPop 2020, Haiti | CC BY 4.0 |
| Elevation, slope, sea / land | Mapzen Terrarium tiles on AWS Open Data | Open (various public sources) |
| Power plants, substations, power lines, canals, water works, hospitals, universities, industrial zones, ports, parks, rivers | OpenStreetMap via Overpass | ODbL |
| Active faults | GEM Global Active Faults | CC BY-SA 4.0 |
| Submarine cables and landing points | TeleGeography Submarine Cable Map | CC BY-NC-SA 3.0 (non-commercial) |
| The plan network (corridors, Périphériques, stations, cities, towns) | This project | — |

Two Port-au-Prince thermal plants (Varreux, Carrefour) are not in OpenStreetMap and were added at approximate locations.
OpenStreetMap tags many small clinics as hospitals; health gaps are measured to facilities whose name says hospital.

## Rules for proposed sites

**Energy**
- Solar parks: slope under 3 %, under 150 people/km², within 6 km of a rail + highway corridor (the grid line follows the corridor), not on irrigable farmland, at least 1 km from an active fault, sites at least 30 km apart, ranked toward large nearby populations. About 1 km² per ≈50 MW.
- Small hydro: on OpenStreetMap rivers longer than 40 km, a 30–150 m drop over 3 km with the lower end between 20 and 600 m. At most two sites per river, 15 km apart. Flow must be measured.
- Wind: indicative measurement sites in four trade-wind areas (Môle-Saint-Nicolas plateau, Anse-Rouge coast, Lac Azuéi basin, Île de la Tortue). A 12-month measurement campaign is needed.
- Islands: solar + battery microgrids for Île de la Gonâve, Île de la Tortue, Île-à-Vache, Grande Cayemite.
- Power backbone: a high-voltage line in the same right of way as every rail + highway corridor.

**Drinking water** — for every city or town with ≥ 40,000 people within 5 km (no two within 5 km of each other): the best point 2–10 km away and 30–260 m higher than the city, so water reaches homes by gravity; on dry land, slope under 25 %, under 1,000 people/km², with a bonus near a river or canal.

**Sewage** — for the same cities: the best point 1.5–8 km away, lower than the city (gravity collection), slope under 6 %, under 600 people/km², at least 3 km from the water plant, with a bonus near the coast for an outfall.

**Agriculture** — 1 km cells with slope under 4 %, elevation below 450 m, within 4 km of a river or canal, 20–1,000 people/km²; grouped into zones of at least 20 km² and named after the plain they sit in. One agro-processing and cold-chain hub per zone, at its point closest to a corridor.

**Housing** — around each ring station (Porte), buildable land within 2.5 km: slope under 10 %, more than 4 m above sea level, at least 0.5 km from an active fault, outside the farm zones. New-town sites 15–45 km from Port-au-Prince (two) and Cap-Haïtien (one), slope under 6 %, under 250 people/km², within 3 km of a corridor, at least 2 km from a fault.

**Investment and logistics** — port-logistics hubs at the lowest station of each coastal Périphérique; an inland dry port at Hinche, where the most national corridors meet; border trade and customs zones at Belladère, Malpasse and Anse-à-Pitre (Ouanaminthe already has the CODEVI free zone); digital and data-center hubs at Port-au-Prince (next to the submarine cable landing) and Cap-Haïtien.

**Connectivity** — a fibre backbone along every rail + highway corridor and Périphérique; satellite internet with shared Wi-Fi for every town more than 8 km from that backbone.

**Health** — cells over 80 people/km² more than 15 km from a hospital, grouped; a new health center at the nearest town for groups over 12,000 people.

**Resilience** — fault crossings wherever a rail + highway corridor crosses a GEM active fault (bridges, tunnels and track there need seismic design). Flood-prone dense areas: land under 5 m elevation with more than 600 people/km².

## Rebuild

```bash
sh tools/fetch-sources.sh     # downloads the open data into tools/.cache/raw (not committed)
node tools/build-dev.mjs      # writes data/dev.geojson, data/pop.json, data/stats.json
```
