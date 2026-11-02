# Changelog

## [Unreleased]

### The sim

- A restarted sim carries on from its log instead of starting the city over. It rebuilds the world from the newest
  keyframe and the records after it, and runs from the next tick at the speed the city was left at: nothing built is lost,
  no tick is repeated or missing, and a tick that only some districts had committed is finished. The command stream is
  followed from where the sim stopped reading (a new `command_cursor` event, recorded on keyframe ticks and on ticks that
  applied commands), so a command sent while the sim was down runs when it comes back and none runs twice. A new city now
  reads its command stream from the start. The epoch in the tick header stays the same across a restart.

### Added

- Timeline markers: a row of buttons above the timeline marks the rush hours (08:00 and 17:15 each day) and every
  building a builder put up or took down, with their name. A click seeks to the moment; marks too close together
  share one numbered button, and clicking it again goes to the next moment in it. The row is a toolbar of its own with
  an accessible name on every button. The sim writes each city day's builder markers to the events stream's state
  (`markers.<day>`, a new record kind 5 in district 0's shard), in the same commit as the tick that made the change;
  tick records and their headers are unchanged. A city with no markers stored reads as before.
- Moments: a **Share this moment** button copies a link such as `/?at=<tick>&cam=<x,z,distance,azimuth,polar>#harbor`
  that opens the city at that tick from that camera view (`?cam` is new). `H` is photo mode and hides every control.
  A page left alone for 60 seconds turns the camera slowly (`?attract=<seconds>`, `0` turns it off).

### Changed

- A district sits on its shard by name, not by hash. The sim commits with `commit_if_on_shard` and reads the keyframe
  pointer with `state_get_on_shard`, and the page's `state_get` names the district's shard (it needs the gateway's
  `shards` feature, in 0.8.0). The salted entity keys (`d<NN>.<n>`), `felix_metro_core::district_key` and its
  WebAssembly export `districtKey` are gone, and the page no longer needs to know how the stream routes. A log written
  with salted keys reads the same: the records and the `keyframe` state are on the same shards.
- Built on Felix 0.6.2: the sim's `felix-client` and `felix-wire` pins, the dev stack and CI images.
- The dev stack runs felix-gateway 0.8.0 (was 0.7.0). It adds `shard` on `state_get`, `past_end`, `offset_for_time` and
  the other opt-in features of that release; the page uses `shard` on `state_get` and none of the others yet.
- The overlay's styles moved from `web/index.html` into `web/src/ui/*.css`, and the picker, loading screen and frame-time
  display into `web/src/ui/`. `docs/ui.md` describes the kit, the motion rules and the wording rules.
- The log's busiest minute is under the 10 KB/s goal. A 20,000-resident city is estimated to write 9.96 KB/s in the evening rush
  (was 17.1) and 8.1 KB/s in the morning (was 13.8), and to average 5.1 KB/s a day (was 8.1). The figures are
  extrapolated, scaled from measured cities of 522 and 5,568 residents, and hold at 4 ticks a second (the sim also
  accepts 8 and 16, which multiplies them). They charge every record the largest header, 22 bytes. Tick records have
  a new layout, kind 4: ids, counts and ticks are varints, times in an event are deltas from the record's tick, an
  `arrived` and the `activity` after it are one entry, and `left` no longer carries the vehicle (the JSON `left`
  event has no `vehicle`, `progress` or `route` fields). A tick with nothing in it is 16 to 22 bytes (the tick and the keyframe offset are varints that grow), not 31. Kind 1 is
  refused, so a log written before this cannot be read: the page shows "Start a fresh city" and the history stays
  unreadable. The dev stack keeps no state between runs. Spreading the
  keyframes over the hour was measured and does not lower the busiest minute, so they stay on the hour (design.md,
  "Log size").
- `report_load` also prints the day mean at 20,000 residents and a denser harbor city, and a test holds the busiest
  minute under 10 KB/s.

### The page

- Ambient life: shop windows that light between a shop's opening and closing, chimney smoke on work hours, birds on
  some roofs at dawn, traffic lights at crossroads, a garbage truck on a morning round and delivery vans on the shopping
  streets. The sim logs none of it, so every effect is a pure function of the tick on screen and the city's seed
  (`web/src/ambient.ts`): a seek or a rewind draws exactly what a forward run does, and each day plans its own rounds. The
  truck and the vans go through the fleet as car kinds 7 and 6. The medium tier draws fewer puffs, birds and vans than
  high, and the low tier keeps only the shop windows. `web/ambient.html` and `web/scripts/check-ambient.mjs` draw the
  same tick twice, after a rewind, and sweep a day for when each effect is on; CI runs it. A test in `core` pins that planned
  departures stay between 04:30 and 23:30 for legs up to an hour, which is why the pavements are quiet at night. Roads closed in the log
  still carry the truck and the vans, and only crossroads have lights.
  ([docs/art.md](docs/art.md#ambient-life))
- A settings sheet, opened from the button under the clock. Quality is Automatic, High, Medium or Low; Automatic
  forgets a saved tier and judges frame times again from High (`Quality.setAutomatic()`).
- A key list, opened with `?` or from the settings sheet. It is data (`SHORTCUTS` in `web/src/ui/keys.ts`), so a new key
  adds a row, and it is ignored while typing in a text field.
- A tip on a first visit, "Drag the timeline to go back in time", shown once the timeline is on screen and gone on the first
  interaction. It is never shown with `?ui=0` or `?capture`.
- The clock's digits roll when they change, and hold still with `prefers-reduced-motion`.
- On a phone, the past row (Play, how long ago, Back to live) moves under the Felix Metro chip instead of covering it.
- The hour slider shows a focus ring when it is reached with the keyboard.
- The clock moves under the Felix Metro chip on a phone while the pill says Reconnecting, since the two overlapped at 360px.
- Space plays or pauses an earlier moment from the timeline too, and does nothing while the settings sheet is open.
- Brand tints in the overlay's CSS are tokens in `kit.css` (`--coral-wash`, `--amber-wash`, `--violet-glow`, `--cyan-glow`).
- Short messages, such as "That moment is no longer kept.", now sit above the timeline in the page's glass style.
- Cars and walkers are drawn as instances (#91). One draw call covers every car of a kind's mesh, one every walker of a
  model's mesh, and three more cover all the car lights, so the first cars and walkers on screen add a fixed 219 draw
  calls on the high tier (155 on medium, 59 on low) and more add none, where each used to add about 18. Cars and walkers
  more than 1.5 tiles outside the view are not drawn. Walkers no longer carry bones: the walk clip is baked into a
  texture per model and a shared clock, offset for each resident, picks the pose (`web/src/walk.ts`). The tier limits on
  cars and walkers drawn at once go from 40 to 80 on low and from 80 to 160 on medium; high is still unlimited. They are
  not measured against a GPU. `web/traffic-load.html` and `web/scripts/check-traffic.mjs` count the draw calls for N
  movers, and `check-traffic-pictures.mjs` compares a car and a walker close up with renders in `web/references`; CI
  runs both. [docs/art.md](docs/art.md#cars-and-walkers) has the details and the numbers.
- A visible look change: car headlights, taillights and the light on the road ahead now show at night on the high and
  medium tiers, and they feed the bloom. They were made after the first frame, so the pass that hides the glows for
  ambient occlusion and the distance blur left them hidden for good. A dense night at 800 movers on high does not blow
  out: the lights read as small points, below the street lamps' pools.
- A car or walker whose trip has just ended is no longer drawn for a frame after it when the page has no new tick.
- Camera controls. Left-drag turns and tilts, right-drag or Shift-drag slides, the wheel and a pinch zoom toward the
  point under the pointer, one finger turns and two fingers slide on a touch screen, and `W` `A` `S` `D`, `Q` `E`,
  `+` `-` and `0` do the same from the keyboard (`0` goes back to the opening view). The point the camera looks at
  cannot leave the city, at any zoom, on a 2 by 2 or a 4 by 4 map. Moves are damped and the camera never bounces.
  The camera is one object with `moveTo`, `state` and `setState` for the features that move it, and a move the app
  makes jumps for a person who asked for reduced motion. `web/src/camera.ts` replaces Three.js's `OrbitControls`,
  with the maths in `web/src/camera-math.ts`.
- Timeline: a drag no longer seeks to a moment retention has just dropped. The drag keeps the bar it began on, so a move
  at the left end could land before the oldest tick the city still holds; it now stops at the oldest one held.
- Scrubbing hard no longer leaves buildings behind. A lot whose building changed twice in quick succession (the
  second before the first was drawn) was drawn twice, and only the older drawing was tracked, so the other stayed in
  the scene for good. A burst of 101 swaps on one lot left 100 stray objects; the construction check now runs that
  burst and wants none.
- The city list no longer depends on `harbor`. A page opened at a city the gateway refuses read the list through a
  hardcoded `harbor`, so the picker was empty whenever that city was missing or closed to the person. It now joins
  `lobby`, which `dev/seed.mjs` creates for this and nothing else. A stack started before this change has no lobby, so
  its picker is empty for a refused city until it is restarted with `dev/up.sh`. The dev-stack check opens `/#nowhere` and wants the cities listed.
- Backward playback and speeds. From an earlier moment, `L` plays forward and each press doubles the speed to 8x, `J`
  rewinds the same way, and `K` stops; Space still plays and pauses. Forward runs from 0.5x to 8x, backward from 1x to
  8x, and the status line names any speed but plain 1x. A rewind refolds the city from the hour's keyframe to each
  tick it passes, reads the hour before ahead, and stops with a note at the oldest moment the log holds. The seeker reads
  the hours on either side of the one on screen while the page is idle and now caches three hours of records per
  district instead of two. `J` on the live city steps back 15 minutes and rewinds from there.

### Tools

- `web/scripts/check-ui.mjs` drives the overlay with the keyboard and takes day and night screenshots at 1280 and 360
  pixels wide. CI runs it as its own job, `overlay controls`.
- The builder bot with `--rebuild` handles a demolish that gets no answer. The sim may have applied it, so the bot
  goes on to the build. If that is refused it builds the old kind back and logs an `orphan` line (`restored: null` if
  the restore gets no answer either).
- An `orphan` line written because the bot exited mid-turn now says `restored: null` (unknown) instead of `false`, and
  `dev/check-builder-bot.mjs` fails on `null` as well as `false`.
- `dev/lib/turn.mjs` holds a lot's turn, so `node --test dev/lib/turn.test.mjs` (run in CI) can test it with a
  stand-in for the sim.
- `clip-local.mjs` points the builder bot at the moved gateway port, and runs its stack as its own compose project so
  its cleanup cannot remove a felix-metro stack started by hand.

## [0.2.2] - 2026-10-25

### Tools

- A Clip workflow (`.github/workflows/clip.yml`) and `web/scripts/clip-local.mjs` that record the getfelix.dev video: the page can draw frame by frame (`?capture&trace`) and a script drives the camera, the tick and the timeline.

### The page

- Timeline: the bar no longer shifts in the first seconds after the page opens. Until the retained range is read, its
  left end followed the live tip tick by tick, so the day bands and hour marks crept and were rebuilt as the city
  advanced. The left end is now fixed from the first tip, and the bar waits for every district to have a tick before it shows.
- Timeline: label the days the bar shows. Until the retained range was read (it is read on hover), the bar started
  one tick before the live tip, so the live head sat at the left edge and the bands were labelled from the tip's
  day on. The bar now starts a day behind the tip until the range is read, so the live head sits at its place on the scale.

## [0.2.1] - 2026-10-24

### The city

- A new city starts with a day behind it. On its first start the sim commits `SIM_WARMUP_HOURS` of ticks
  (40 by default, so live begins at 16:00 on day 2) as fast as the broker takes them, then runs at normal
  speed. The page opens on an evening commute with history to scrub through instead of an empty dark city.
  Warm-up ticks are stamped with wall times spread back from the start of the warm-up at the city's speed.
  A city with records, or one that starts paused, skips it; `SIM_WARMUP_HOURS=0` starts at midnight as before.
- `dev/lib/gateway.mjs` skipped each keyframe resident one byte short, so a keyframe with events after it
  misparsed once residents were mid-trip; the command check now reads them.
- `GET /cities/<name>/warmup` on the sim's endpoint says whether a city is still warming up, and `dev/up.sh`
  (and the compose bundle's `up.sh`) waits for every city to go live.
- A city is listed in the registry only once its warm-up is done, so the picker never offers a city whose districts
  are still far apart in the log.
- A sim killed during warm-up leaves partial history and is refused on restart, so the streams need a reset
  (`dev/up.sh` starts fresh); restarting over history is tracked in
  [#105](https://github.com/GetFelix/felix-metro/issues/105).

### Fixed

- A failed depth pre-pass no longer leaves the depth material on the scene and the glows hidden for
  every later frame.
- The timeline bar holds still while it is dragged. Its scale used to follow the growing city, so in a
  young city each pointer move mapped to a different moment and the drag flashed. A drag now keeps the
  scale it began with, and releasing at the right end goes live. The bar spans at least one city day,
  so the live head moves right across a fixed scale and the part after it is dimmed as not yet
  happened, and a press before the span the city holds has been read waits for it instead of mapping
  through a one-tick placeholder.
- A press on the live head picks the handle up at once; it used to land on the head's own button, so the
  bar needed a click before it could be dragged.

### Changed

- The blur is far-only. Nothing in front of the focus is blurred, a sharp band as wide as the camera
  distance follows it, and a gentle haze (amount 3.5, down from 7) builds toward the horizon, so the
  city reads sharp at the default view and zoomed in. The style frame uses the same blur.
- People on the pavements: a route of 8 tiles or less is walked (it was 4), so lunches, shopping and park trips are on foot. The harbor city at 2 by 2 peaks at 72 walkers instead of 20 and 72 cars instead of 91, and the busiest district holds 24 to 36 walkers at the rush and about 21 at lunch. Walkers are drawn about 1.3 times larger. The log rate is unchanged: trips are still route intents.
- Cars and walkers no longer vanish on the road: in the last tick of a trip they turn off the road onto the lot the trip leaves or enters, on whichever side of the road it stands, and shrink away; a departure does the reverse. The pose is a function of the trip and the tick alone, so a rewind or seek draws the same.

## [0.2.0] - 2026-10-24

### Changed

- Built on Felix 0.6.1: the sim's `felix-client` and `felix-wire` pins, the dev stack and CI images.

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
- The builder bot grows on the development area first and no longer demolishes by default (`--rebuild` opts in,
  and restores the old building when the build that follows is refused). A second SIGINT exits at once.
  `dev/check-builder-bot.mjs` counts net new buildings, so a run that only rebuilds fails; CI requires ten.
- `dev/builder-bot.mjs` grows a neighbourhood through the gateway for demos and the clip, reading every result and never retrying a refused lot. The dev scripts share `dev/lib/gateway.mjs`, and the core crate has a `city_json` example that prints a city with the lots residents go to.
- The page's fold follows `road` events and a keyframe's road list.
- `dev/check-commands.mjs` publishes commands as a mayor from a plain client; the
  dev-stack CI job runs it. It reads keyframe records too, fails when a result never
  appears, and checks a later keyframe lists the built lot.

### The city

- Each city sets aside a development area of 14 to 16 empty lots in one district, for builders. Residents never
  choose them as home, shop, park or work, so the sim accepts builds there, and the page draws them as bare
  earth. `City::development`, the city JSON and `City::hash` carry it. This changes every seed's layout hash and
  residents (golden hashes updated): the harbor city at 2 by 2 keeps its 522 residents (the area's lots still count toward the population) and up to 91 cars
  at once, and the step-time test loads 64 residents a home to stay at its 1,000 a district. Pinecrest
  loses 15 lots to it, harbor 14.
- Rush hour is busier. A city has six residents per home instead of two, office
  workers arrive 07:45 to 08:15 and leave 17:00 to 17:30, shopkeepers arrive 07:45 to
  08:30 and leave 17:00 to 18:30, office
  workers go out to the shops at lunch, errands pick the nearest of eight
  places so more are walked, and half the retirees go out in the afternoon.
  The harbor city at 2 by 2 districts has 522 residents (was 174) and up to 104
  cars on the road at once (was 18). A seed generates different residents and
  schedules than before; there is no compatibility with logs written earlier.
- The rush writes more than the 10 KB/s goal. A 20,000-resident city averages about 8 KB/s a
  day but writes about 17 KB/s in the busiest minute of the rush, when every
  district's hourly keyframe lands with the commute. The README and design say so; #95 tracks bringing it back.

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
