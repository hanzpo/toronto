"""GTFS sources for the transit pipeline (downloaded into pipeline/raw/gtfs/{key}.zip).

Each entry:
  name        display name
  url         static GTFS zip (primary); `mirror` = Mobility Database copy
  rail_mode   mode for rail route_types (0/1/2 and extended rail types) unless
              overridden per route; default by route_type
  route_modes {route_short_name: mode} per-route overrides
  route_colors {route_short_name: "RRGGBB"} per-route colour overrides
  mode_colors {mode: "RRGGBB"} colour for every route of a mode
  bus         False to drop route_type 3 routes of this feed

Run `python -m tpipe.transit --download` to (re)fetch missing zips.
"""

from __future__ import annotations

MDB = "https://files.mobilitydatabase.org/{}/latest.zip"

SOURCES: dict[str, dict] = {
    "ttc": {
        "name": "TTC",
        "url": "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC%20Routes%20and%20Schedules%20Data.zip",
        "route_modes": {"5": "lrt", "6": "lrt"},
        "route_colors": {"1": "F8C300", "2": "00923F", "4": "A21A68", "5": "FF8000", "6": "969696"},
        "mode_colors": {"streetcar": "ED1C24"},
        "text_colors": {"1": "000000"},
    },
    "go": {
        "name": "GO Transit",
        "url": "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
        "rail_mode": "commuter_rail",
    },
    "up": {
        "name": "UP Express",
        "url": "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip",
        "rail_mode": "airport_rail",
    },
    "via": {
        "name": "VIA Rail",
        "url": "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip",
        "rail_mode": "intercity_rail",
    },
    "yrt": {"name": "YRT / Viva", "url": "https://www.yrt.ca/google/google_transit.zip"},
    "miway": {"name": "MiWay", "url": "https://www.miapp.ca/GTFS/google_transit.zip"},
    "drt": {"name": "Durham Region Transit", "url": "https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip"},
    "grt": {
        "name": "Grand River Transit",
        "url": "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
        "route_modes": {"301": "lrt"},
        "route_colors": {"301": "0096D6"},
    },
    "hsr": {"name": "Hamilton Street Railway", "url": "https://opendata.hamilton.ca/GTFS-Static/google_transit.zip"},
    "brampton": {
        "name": "Brampton Transit",
        "url": "https://www.arcgis.com/sharing/rest/content/items/a355aabd5a8c490186bdce559c9c75fb/data",
        "mirror": MDB.format("mdb-1994"),
    },
    "burlington": {
        "name": "Burlington Transit",
        "url": "https://opendata.burlington.ca/gtfs-rt/GTFS_Data.zip",
        "mirror": MDB.format("mdb-724"),
    },
    "oakville": {
        "name": "Oakville Transit",
        "url": "https://www.arcgis.com/sharing/rest/content/items/d78a1c1ad6a940009de8b68839a8f606/data",
        "mirror": MDB.format("mdb-725"),
    },
    # Niagara Region Transit: includes former St. Catharines Transit, Niagara Falls
    # Transit / WEGO (routes 602-604), Welland and regional links.
    "niagara": {
        "name": "Niagara Region Transit",
        "url": "http://68.71.24.110/gtfs/GTFSExport.zip",
        "mirror": MDB.format("tld-859"),
    },
    "guelph": {
        "name": "Guelph Transit",
        "url": "https://gismaps.guelph.ca/Pages/GTFS/google_transit.zip",
        "mirror": MDB.format("mdb-3140"),
    },
    "barrie": {
        "name": "Barrie Transit",
        "url": "http://www.myridebarrie.ca/gtfs/Google_transit.zip",
        "mirror": MDB.format("mdb-3"),
    },
    "milton": {
        "name": "Milton Transit",
        "url": "http://metrolinx.tmix.se/gtfs/gtfs-milton.zip",
        "mirror": MDB.format("mdb-759"),
    },
    # Bradford (BWG Transit) went on-demand in 2025; no static GTFS exists.
}

# Dates never used as representative service days (Ontario statutory holidays etc.).
HOLIDAYS = {
    "20260907", "20261012", "20261225", "20261226", "20261228", "20270101",
    "20270215", "20270326", "20270524", "20270701", "20270802", "20270906",
}
