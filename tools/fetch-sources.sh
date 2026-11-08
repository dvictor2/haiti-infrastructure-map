#!/bin/sh
# Re-downloads the open datasets used by tools/build-dev.mjs into tools/.cache/raw (not committed).
set -e
cd "$(dirname "$0")"
mkdir -p .cache/raw && cd .cache/raw
# 1 km land grid used for terrain analysis — WorldPop 2020 (CC BY 4.0)
curl -sSL -o pop.zip https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km_UNadj/2020/HTI/hti_pd_2020_1km_UNadj_ASCII_XYZ.zip
unzip -o -q pop.zip
# Population 2023, 400 m hexagons — Kontur (CC BY 4.0)
curl -sSL -o kontur.gpkg.gz https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_HT_20231101.gpkg.gz
gunzip -f kontur.gpkg.gz
python3 ../../kontur-to-points.py kontur.gpkg kontur-points.json
# Active faults — GEM Global Active Faults (CC BY-SA 4.0), cut to Haiti by build-dev
curl -sSL -o faults.geojson https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults_harmonized.geojson
# Existing infrastructure — OpenStreetMap via Overpass (ODbL)
curl -sS -m 200 -A "haiti-infrastructure-map (planning map)" --data-urlencode data@../../overpass-query.txt https://overpass-api.de/api/interpreter -o osm.json
echo done
# Named rivers — OpenStreetMap
curl -sS -m 200 -A "haiti-infrastructure-map (planning map)" --data-urlencode data@../../overpass-rivers.txt https://overpass-api.de/api/interpreter -o rivers.json
# Coastline (land test for fix-geometry) and airfields/runways — OpenStreetMap
curl -sS -m 200 -A "haiti-infrastructure-map (planning map)" --data-urlencode data@../../overpass-coast.txt https://overpass-api.de/api/interpreter -o coast.json
curl -sS -m 200 -A "haiti-infrastructure-map (planning map)" --data-urlencode data@../../overpass-airports.txt https://overpass-api.de/api/interpreter -o airports.json
