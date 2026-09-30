# Static QA results

One row per `uv run python -m tpipe.qa --record` run (counts per category; see docs/QA.md). Newest last.


| date (UTC) | build | scope | runtime | bridge_width_anomaly | building_overlap | dash_phase_break | deck_below_clearance | duplicate_footway | elevation_jump | flat_crossing | floating_object | footway_as_road | junction_hardware_on_grade_sep | landmark_overlap | prop_in_lane | rail_gap | rail_kink | raster_shore | road_below_terrain | road_overlap_nonjunction | road_width_step | route_track_conflict | sidewalk_bridge_discontinuity | transit_route_off_road | transit_wrong_way | tree_on_airfield | tree_on_rail | tree_on_road | tree_on_water | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-30 05:11 | 1790742159 | region | 175s | 782 | 6152 | 17716 | 8390 | 54401 | 2337 | 103 | 0 | 5375 | 2432 | 4 | 21740 | 127 | 3215 | 13782 | 98 | 10412 | 17380 | 18 | 2765 | 14823 | 12258 | 0 | 23 | 189 | 4 | first full run (props dump 34213642dc5e, 2 workers, peak RSS 1.2 GB) |
