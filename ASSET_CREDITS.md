# 3D asset credits

Third-party 3D models used on the map, all with licences that allow public use. The map's attribution line links here.

Source pack: [Modern Rail and Metro Network](https://3dassets.dev/packs/modern-rail-and-metro-network) on 3DAssets.dev. The pack page says its models were made with AI assistance and human-reviewed before publication.

| File | Asset | Creator | Source | License | Changes |
|---|---|---|---|---|---|
| `assets/models/train-power-car.glb` | High speed power car | 3dassets | [modern-rail-and-metro-network-high-speed-power-car-a6dc258e](https://3dassets.dev/assets/modern-rail-and-metro-network-high-speed-power-car-a6dc258e) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/train-trailer-car.glb` | High speed trailer car | 3dassets | [modern-rail-and-metro-network-high-speed-trailer-car-e82de8c5](https://3dassets.dev/assets/modern-rail-and-metro-network-high-speed-trailer-car-e82de8c5) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/platform-island.glb` | Island platform module | 3dassets | [modern-rail-and-metro-network-island-platform-module-f7c68962](https://3dassets.dev/assets/modern-rail-and-metro-network-island-platform-module-f7c68962) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/platform-ramp.glb` | Island platform end ramp | 3dassets | [modern-rail-and-metro-network-island-platform-ramp-810621a7](https://3dassets.dev/assets/modern-rail-and-metro-network-island-platform-ramp-810621a7) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/platform-canopy.glb` | Platform canopy | 3dassets | [modern-rail-and-metro-network-platform-canopy-4d0acf71](https://3dassets.dev/assets/modern-rail-and-metro-network-platform-canopy-4d0acf71) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/track-6m.glb` | Ballasted track straight 6 m | 3dassets | [modern-rail-and-metro-network-ballasted-track-straight-4c5f4217](https://3dassets.dev/assets/modern-rail-and-metro-network-ballasted-track-straight-4c5f4217) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/catenary-mast.glb` | Catenary mast with cantilever | 3dassets | [modern-rail-and-metro-network-catenary-mast-cantilever-5de1f0c1](https://3dassets.dev/assets/modern-rail-and-metro-network-catenary-mast-cantilever-5de1f0c1) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/platform-shelter.glb` | Platform shelter | 3dassets | [modern-rail-and-metro-network-platform-shelter-8a2de8c7](https://3dassets.dev/assets/modern-rail-and-metro-network-platform-shelter-8a2de8c7) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |
| `assets/models/departure-board.glb` | Departure board | 3dassets | [modern-rail-and-metro-network-departure-board-f2a0d2d6](https://3dassets.dev/assets/modern-rail-and-metro-network-departure-board-f2a0d2d6) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | None (renamed file) |

## Sketchfab models (CC BY 4.0: free to use, credit required)

| File | Asset | Creator | Source | License | Changes |
|---|---|---|---|---|---|
| `assets/models/plane-a320.glb` | White Airbus A320-200 | Dave Love ([Tyler_Dave](https://sketchfab.com/Tyler_Dave)) | [sketchfab.com](https://sketchfab.com/3d-models/white-airbus-a320-200-cf7c3f80fced48d18d6409af66579c62) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | Compressed (meshopt geometry, WebP textures max 1024 px) |
| `assets/models/wind-turbine.glb` | Wind Turbine | [DoobiDooba](https://sketchfab.com/DoobiDooba) | [sketchfab.com](https://sketchfab.com/3d-models/wind-turbine-285032402a8543ae8bf3e3c4d8c9f98a) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | Compressed (meshopt, WebP 512 px); scaled ×6.5 on the map |
| `assets/models/solar-panel.glb` | Solar Panel | Harri Snellman ([rivetech](https://sketchfab.com/rivetech)) | [sketchfab.com](https://sketchfab.com/3d-models/solar-panel-83483a66f8974d7e8f2e7bbde518d606) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | Compressed (meshopt, WebP 512 px) |
| `assets/models/container-ship.glb` | Container Ship | [RM02](https://sketchfab.com/RM02) | [sketchfab.com](https://sketchfab.com/3d-models/container-ship-aaa41cca946b4a08bc08cf692b7757be) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | Compressed (meshopt, WebP 1024 px); scaled ×1.4 on the map |

## Adding a model

1. Check the licence first (CC0 preferred; CC BY only with the attribution added here). No NC / no-redistribution assets (TurboSquid-style licences forbid downloadable web files).
2. Keep files light: `npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 1024 --simplify false` (add `--join false --flatten false` when a part must move, like turbine blades).
3. Put the `.glb` in `assets/models/`, add a row above, add a builder in `models3d.js` and a place in `MODEL_PLACES` (app.js).
