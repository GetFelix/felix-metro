- `place road` and `remove road` (command tag 8) are carried out. A road joins two existing intersections in one row or
  column over bare ground, at most 12 tiles long, costs $100 a tile, and never crosses or touches another road; only a
  road a builder added can be removed, for $100. Segment ids are never reused. Each is a `roadwork` event (extended
  kind 6), and keyframes list every built road, removed ones included, so a restart or a late page rebuilds the same
  city. When a road goes, every vehicle whose way used it is sent another way from the intersection it was heading for,
  in the same tick, with a `replan` event (now `resident, vehicle, node, route`). Results 20 to 24 are new refusals.
