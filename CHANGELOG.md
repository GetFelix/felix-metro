# Changelog

## [Unreleased]

### Building

- A building rises over 8 ticks from its `built` tick inside a timber scaffold, and a demolished one
  scales down under a puff of dust. The picture is a function of the event's tick and the tick on
  screen, so a rewind plays it backwards and a seek into a window shows the right partial state.
  A seek within 8 ticks of its keyframe also reads the records before it, since a keyframe lists the
  finished lot without when it began. The low tier skips the scaffold and the dust. CI renders a lot
  mid-rise and mid-fall at a fixed tick, by a forward run, a seek and a rewind, and compares them
  with `web/references/`, a quarter of the way in as well as the middle.
- Construction is dropped by the tick on screen, not the newest record, so records applied ahead
  of the picture do not cut a rise short. A live keyframe keeps the animations in progress. A
  scrub that shows a cached keyframe first still finds when a nearby building began. A demolition
  now shows the scaffold and a darker, denser dust, and a crowd of builds goes without scaffold,
  dust or stand-in building for the whole window instead of popping in late.
- The sim reads each city's command stream and applies `build` and `demolish` before
  the next tick. Every command is recorded as a `command` event with a hash of who
  sent it and a result, in the district it touched, beside the `built` or
  `demolished` event it caused. A refused command is recorded with its reason and
  changes nothing.
- The `speed` command sets the city's speed and resumes a paused city. The loopback
  endpoint stays for operators.
- A commanded speed is the city's speed: the operator endpoint reports it, and it holds
  until someone sets another. A paused city holds a bounded queue of commands and
  records the overflow as refused (result 9) once it resumes.
- A resume queued behind a pause is no longer stranded, an operator setting that lands during a commanded change is no longer overwritten, a flood past what a paused city holds logs once per pause, and a closed command stream is logged as an error.
- The sim keeps retrying to follow a city's command stream at startup instead of running without builders after one refusal.
- `place road`, `zone` and `fork` are refused as unsupported for now.
- The page's fold follows `road` events and a keyframe's road list.
- `dev/check-commands.mjs` publishes commands as a mayor from a plain client; the
  dev-stack CI job runs it. It reads keyframe records too, fails when a result never
  appears, and checks a later keyframe lists the built lot.

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
