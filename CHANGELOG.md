# Changelog

## Unreleased

### The city

- Rush hour is busier. A city has six residents per home instead of two, office
  workers arrive 07:45 to 08:15 and leave 17:00 to 17:30, shopkeepers arrive 07:45 to
  08:30 and leave 17:00 to 18:30, office
  workers go out to the shops at lunch, errands pick the nearest of eight
  places so more are walked, and half the retirees go out in the afternoon.
  The harbor city at 2 by 2 districts has 522 residents (was 174) and up to 104
  cars on the road at once (was 18). A seed generates different residents and
  schedules than before; there is no compatibility with logs written earlier.
- The log is sized for its peak. A 20,000-resident city averages about 8 KB/s a
  day but writes about 17 KB/s in the busiest minute of the rush, when every
  district's hourly keyframe lands with the commute. The README and design say so.

### The look

- The page draws at most 40 cars and walkers on the low tier and 80 on medium
  (no limit on high); the rest appear as others arrive. Walkers no longer cast
  shadows. Instancing is tracked in #91.

## [0.1.0] - 2026-10-24

The first release: a generated city that runs live in the browser on Felix. It
covers the look and the first milestone, a live city.

### The look

- A style frame for the art direction, with day and night renders.
- An asset pipeline that builds colormap variants once per pack.
- Daylight as one function of the hour, with staggered windows and lamps.
- Post processing as a pass list that a quality tier can trim.
- Quality tiers chosen from frame time, and a frame-time HUD.

### The city

- City generation from a seed, and a layout with arterials, varied blocks and
  land-value zoning.
- Residents, schedules and routing.
- Records for tick, keyframe, command and registry, encoded the same in the sim
  and the browser.

### The sim

- The sim steps a city and commits one record per district per tick, with an
  hourly keyframe.
- City speed: pause, 4, 8 or 16 ticks a second.

### The live city

- A development stack of Felix, the gateway, a stand-in sign-in provider, the sim
  and the web app, started with `dev/up.sh` under Docker or Podman.
- The browser draws the city live, with cars and walkers moving in time with the
  sim.
- A loading screen that fills in district by district, a `Reconnecting…` pill, and
  catch-up from the log after a dropped connection.
- A registry of cities and a city picker.

### Release

- Images `ghcr.io/getfelix/felix-metro-sim` and `felix-metro-web` for amd64 and
  arm64, a compose bundle that runs them, and the built web app.

Built on Felix 0.6.0 and felix-gateway 0.7.0.
