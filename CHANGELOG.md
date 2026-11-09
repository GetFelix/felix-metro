# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-09

This release uses Felix 0.7.0 and needs a Felix 0.7 broker and control plane.

### The sim

- A first case file, the city `ember`: a seed nobody can command. The sim refuses every build, road and policy there with
  "unsupported" and skips the warm-up, so its first day is the same for everyone. The dev stack seeds `ember` and holds it
  back; `dev/city.sh ember` starts it.
- The sim records who built each building. On every keyframe tick each district writes an `author` event (an
  extended event, kind 3: a builder's hash and name and the lots they built that still stand, with the tick each was built) per builder
  and district, so a page that starts from a keyframe can say who built what. A restart restores them from the newest
  keyframe tick and the `command` and `built` events after it. Each lot costs 2 to 5 bytes an hour (under 0.1 B/s) and
  a test holds the evening rush under the 10 KB/s goal with 80 built lots added. A city nobody has built in writes
  none, so the log-size figures are for that city.
- A `fork` command makes a new city `<city>~<name>` from a past tick. The fork copies the parent's history through that
  tick into streams of its own, is listed in the registry with who made it, and ticks on independently. New result codes
  16 to 19 refuse a bad or too deep name, a tick that has not run and a name already taken, and a `forked` event
  (extended kind 7) records it in the parent. A sim needs `SIM_FORK_PROVISION_URL` (a service that makes the streams;
  the dev stack runs `dev/provision.mjs`) or it refuses `fork` as before. A fork has its parent's seed, so `City::generate`
  and `resident_name` draw from the part of the name before the first `~`. The registry's `forked` record gains the
  forking principal. See docs/design.md, Branching.
  Result 20 refuses a fork of a city whose log retention has trimmed, and 21 a fork past `SIM_MAX_FORKS_PER_CITY` (default
  8, forks of forks counted against the root). A fork's copy leaves out its parent's `forked` events, a restart resumes
  only a city's own forks, and a fork listed twice in the registry starts one city. City names in `SIM_CITIES` and
  `SIM_ON_DEMAND` may no longer hold `_`.

### Changed

- Built on Felix 0.7.0: the sim's `felix-client` and `felix-wire` pins, the dev stack and CI images.
- The night sound is a quiet field recording of crickets instead of two pulsed tones, which rang like a phone. The
  recording is CC0 (credited in `prototype/assets/CREDITS.md`), plays low under the traffic bed, starts from a random point
  and drifts in level at irregular gaps, so nothing repeats on a beat. It still follows dusk and dawn and respects the
  sound button.

### Fixed

- `?as=mayor` signs in as the mayor in a tab that already holds a token for someone else, such as a duplicated or Cmd-clicked tab, where the page used to keep the cached viewer token and ignore `?as`. A real provider still ignores `?as`.
- Cars, walkers, delivery vans and the garbage truck no longer collapse into buildings and parks when a trip ends. They turn in from the road, go up to the
  lot's door at full size and are hidden there by the building; a trip leaving a lot comes out of its door the same way.
  Before, each shrank to nothing while sliding to the lot's middle over the last tick, which looked like being sucked in.
- The live clock keeps half a second of real time (2 ticks at the default speed, 8 at 16 ticks a second) behind the newest
  tick instead of one tick, so a record that arrives a few hundred ms late no longer freezes the cars until the next one.
- The sea no longer looks like a mirror. It is shaded by depth (lighter at the shore, darker offshore), ripples a little,
  catches a pale sheen of the sky at a low angle and has a line of foam at the beach, and it no longer reflects a bright
  blob of the room onto the page. The low tier draws it in one flat colour.
- The shoreline is no longer squared off. The page draws a smoothed, slightly wandering coast inside the sim's water tiles
  (the same seed gives the same coast) and a sand beach in the strip the water gives up. The water never covers a land
  tile, so no road or lot overhangs it.
- Trees no longer stand on the water. Every tree the page places by hand, in the landscape past the map and on a lot,
  must be on land and clear of the beach. The trees past the map used to line the whole side of the map, including where
  the sea runs past its corners.

### The page

- A Case section in the council of a case file: the question about the day's busiest street, hour and purpose, two hints
  (a two-hour window and a street that crosses the answer), and a choice for each part. The page says only whether all three
  are right and counts the tries.
- Point at a building (tap it on a phone) and a card says who built it and when: "Built by Ana · Day 2, 09:12 · See
  it go up". Your own read "Built by you", and buildings the city began with read "Here since the start". "See it go
  up" takes the city to 30 city seconds before the building was built through the timeline's own seek, and plays it
  forward. The page asks the gateway for the `principal` feature to know which buildings are yours; a gateway without
  it (before 0.8.0) shows names only. The card is left out with `?ui=0`.
- A tap is timed from when the browser made the touch events, so a busy page that handles them late still opens the card.
- On a phone the card stays after the tap that opened it; the finger leaving the canvas used to hide it a third of a second later.
- The card for a very long builder name no longer runs off the right edge of a phone screen.
- The generated city is drawn as instances. Every road tile, lamp, building, tree and prop was an object of its own, so
  draw calls grew with the size of the city: 6,317 for the default 2 by 2 districts and 25,103 for 4 by 4 on the high
  tier. A model's mesh is now drawn once for all its places, so the same cities draw 205 and 235 calls, and the frame on
  an Apple M4 Max falls from 10.1 ms to 1.8 ms (2 by 2) and from 35.9 ms to 4.4 ms (4 by 4) at 1280 by 720. The look is
  the same: windows still light by the hour, a rising building still scales out of its lot, and a click still finds its
  lot. docs/art.md, "The static city", says how.
- The sun's shadow map is drawn once a frame, not once for every pass that draws the scene, and the distance blur on the
  high tier reads the depth the ambient occlusion pass already drew instead of drawing it again.
- The automatic quality choice no longer takes a 60 Hz display whose frames each take two refreshes for a 30 Hz display.
  A steady 28 to 30 fps was never stepped down, because the choice read the display's rhythm from the frames alone. When
  a window of frames is too slow for 60 Hz but fit for 30 Hz, the page now draws nothing for a dozen frames, reads the
  display's real interval from them and decides with it. `?hud` shows the display it measured.
- A sign-in that cannot build is told who it is and the way out: `Signed in as viewer, who can only watch. Open ?as=mayor in a new tab to build.` with `?as=mayor` a link on the dev stack, and the build role to ask for with a real provider. A city whose sim has not started says `Pier is not running. Start it with dev/city.sh pier (./city.sh pier in the release bundle).` instead of refusing the build; one that is not held back says to check the sim or restart the stack.

### Tools

- `dev/check-restart.mjs` also checks that the keyframes after a restart still say who built each lot, and when.
- `web/scripts/check-attribution.mjs` hovers a building someone built and a generated one in the live page, reads the
  card, and follows "See it go up". CI runs it in the dev-stack job.
- The traffic check bounds the draw calls of the whole frame (`TRAFFIC_MAX_CALLS`) and of the 16 district measuring page
  (`TRAFFIC_MAX_RUN_CALLS`), so the static city cannot go back to a draw call for each object. `web/traffic-load.html`
  gives scripts the renderer and scene as `window.__three`.
- The seek check waits for the follow card and the camera to reach the resident instead of a fixed second and a half, and logs how long that took. CI draws the page in software at well under one frame a second, so the fixed wait could end before the frame that shows the card.
- The live page check clicks another car when a click misses one that has moved on since it was drawn, and the day card check pages through days from the day the card shows, so a city that crosses midnight mid-check does not fail it.
- The dev-stack checks no longer fail on a slow runner: the playback check allows the live tip to move on during the frame that notices the join, and the day check accepts the card on a later day when the city crosses midnight while the log is read.
- The two-builders check parks the frames of every open page while another one loads, and opens its pages one after the other, so a page that is already drawing cannot keep a new one from ever drawing.

## [0.2.3] - 2026-11-02

### The sim

- A restarted sim carries on from its log instead of starting the city over. It rebuilds the world from the newest
  keyframe and the records after it, and runs from the next tick at the speed the city was left at: nothing built is lost,
  no tick is repeated or missing, and a tick that only some districts had committed is finished. The command stream is
  followed from where the sim stopped reading (a new `command_cursor` event, recorded on keyframe ticks and on ticks that
  applied commands), so a command sent while the sim was down runs when it comes back and none runs twice. A new city now
  reads its command stream from the start. The epoch in the tick header stays the same across a restart.

- The city has funds. It starts with $100,000; each city day residents and businesses pay tax and roads and parks cost
  upkeep, and building or demolishing takes a price when the command applies. A command the city cannot pay for is
  refused with result 10. The sim records a `ledger` event per district per day and per paid command, and a `balance`
  event per district on every keyframe tick; a restart restores the account. The page shows the funds beside the clock,
  and shows the funds of the moment you scrub to.
- The city has a council of three factions: commuters, the shore's residents and shops. Each day the sim scores how
  well the city met what they ask for (a trip to work or school of 12 minutes or less, 80% of residents living away
  from factories, 5 visits a day for each shop). A faction unhappy for 3 days in a row recalls the mayor; the city carries
  on. The sim writes a `council` event on every keyframe tick and a restart restores it. The page folds the council to a
  line below the funds that opens to the demands and a countdown to a recall.
- A `policy` command sets shop hours (0 to 3 hours later than usual) or the speed limit on avenues or on streets
  (30 to 100 percent of their speed). Later hours keep shopkeepers at work longer and raise shop tax; a limit slows
  every trip that drives that class of road. Each policy can change once a city day, otherwise the command is refused
  (result 11; result 12 for the value it already has). The sim writes a `policy` event when one changes and on every
  keyframe tick after the first change, and a restart restores the values and cooldowns. The page lists them under the council.
- A first chapter, the city `pier`: it opens with the avenue limit at 40% and the street limit at 60%, so commuters
  average 24 minutes and the council recalls the mayor in 3 days unless the limits are raised. A chapter's first tick
  is the sim's first tick (no warm-up), and a restart before any policy change keeps the chapter's opening limits.
  The dev stack seeds `pier` and holds it back; `dev/city.sh pier` starts it.
- `place road` (command tag 1) and the new `remove road` (tag 8) are carried out. A road joins two existing
  intersections in one row or column over bare ground, at most 12 tiles long, costs $100 a tile, and never crosses or
  touches another road; only a road a builder added can be removed, for $100. Segment ids are never reused. Each is a `roadwork` event (extended
  kind 6), and keyframes list every built road, removed ones included, so a restart or a late page rebuilds the same
  city. When a road goes, every vehicle whose way used it is sent another way from the intersection it was heading for,
  in the same tick, with a `replan` event (now `resident, vehicle, node, route`). Results 22 to 26 are new refusals.

### Added

- Moments: a **Share this moment** button copies a link such as `/?at=<tick>&cam=<x,z,distance,azimuth,polar>#harbor`
  that opens the city at that tick from that camera view (`?cam` is new). `H` is photo mode and hides every control.
  A page left alone for 60 seconds turns the camera slowly (`?attract=<seconds>`, `0` turns it off).
- Follow a life: click a car or walker (tap on a touch screen, or press `F` for the one nearest the middle of the view)
  and the camera follows that resident, with a card under the city name that shows their name, what kind of resident
  they are, what they are doing now and their day. The resident is known by number, so the follow holds across districts
  and through seeks, scrubs and rewinds; indoors the camera stays on their building and the card says what they are
  doing there. `Esc`, the card's button or moving the view lets go; turning and zooming keep the follow.
  `?follow=<resident>` opens a page on one, and **Share this moment** adds it to the link. The key list has a Following
  group. `core`'s WebAssembly `Metro` gains `population()` and `profile(resident)`, a resident's name, kind and day as
  JSON.
- A resident's day from the log: the follow card now lists the trips and stays the sim wrote for the resident, a day at a
  time, instead of their schedule. Arrows move to the day before or after, a click on an entry seeks the timeline to
  that moment, and while the day is today new trips and arrivals appear as they happen. A trip that left late or a stay
  that ran long shows the time it really did. A page with no log still lists the schedule, labelled as their usual day.
  `Seeker.scan` reads a range of records without caching them.
- Timeline markers: a row of buttons above the timeline marks the rush hours (08:00 and 17:15 each day) and every
  building a builder put up or took down, with their name. A click seeks to the moment; marks too close together
  share one numbered button, and clicking it again goes to the next moment in it. The row is a toolbar of its own with
  an accessible name on every button. The sim writes each city day's builder markers to the events stream's state
  (`markers.<day>`, a new record kind 5 in district 0's shard, one value a day under 20 KB), in the same commit as the tick that made the change;
  tick records and their headers are unchanged. A city with no markers stored reads as before.
- City stats: a panel on the left edge shows the residents, how many are on the road (in cars and on foot) and the
  buildings by kind (homes, shops and offices, towers, factories) for the moment on screen, so the numbers change as you
  scrub, rewind or seek. Press `C` or use the switch in the settings sheet; the choice is remembered. A test follows the
  sim's own log of a morning and checks the count against the sim at every tick.
- The page's own building tools: **Build** and **Demolish** buttons beside the settings button (keys `B` and `X`), a
  panel to choose the building, `R` to turn it and `[` `]` to step through them, and a ghost of the building that follows
  the pointer from lot to lot. Click, or tap, to place it. Commands go out only from the live city, only for a sign-in that
  may build, and only on the development area; the panel says in plain words what became of each one. `?as=mayor` signs
  in as the builder at the dev stack's stand-in sign-in. Zones are not built yet. The dev stack's seed takes
  `METRO_BUILDERS`, and CI checks two builders editing at once.
- A **Road** tool beside Build and Demolish (key `Y`). Click a crossing, then another in the same row or column, and a
  ghost of the road lies between them: cyan where it fits, red with the reason in the panel where it does not. A second
  click sends `place road`. Clicking a road a builder laid sends `remove road`; the city's own streets stay. `Esc` drops
  the first end. On a touch screen a road or a removal takes a second tap to confirm. The page offers only the cleared
  ground and filler lots with no door, so a stock city has one place for a road; the sim's own refusals are told in
  plain words.
- The page draws the roads builders lay and take away, in the live city and in the past: a rewind or a seek to before a
  road takes it off the screen, and one past its removal puts the trees and plots back. A car on a road that is taken
  away is sent another way from its next crossing at once, as the sim's `replan` event says. Zones are still not built.
- The design notes now say what history the dev stack keeps (7 days or 1 GiB per stream) and link the Felix issue for reading offloaded history back.

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

- Optional ambient sound, off until turned on. A speaker button beside the settings button, or the `M` key, switches it;
  the choice is kept in local storage and nothing plays before a click or key press. Traffic by day fades into crickets
  at dusk and back at dawn, following the city's clock, and a whoosh plays when a rewind or a scrub into the past starts
  (at most once every 1.5 seconds). It is synthesised with the Web Audio API, so there is no audio asset. It is not shown
  with `?ui=0` or `?capture`, and a browser that blocks audio gets a short note and no console error.
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
- The council lists a chapter's goals (the commute, no recall, funds above zero) with the day or the outcome, and calls
  the chapter won or lost once day 3 is scored. The chapter's numbers come from core, the same table the sim plays.

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
- The frame-time overlay (`?hud`) shows the frame rate. `web/traffic-load.html` takes `?run=1` to keep drawing with the frame rate on the page, `?districts=4` for the 16 districts of the scale goal and `?cap=tier` to hold the movers drawn to the tier's cap; the CI traffic check runs it.
- Changelog entries go in `changelog.d/<name>.<section>.md` instead of `CHANGELOG.md`, so parallel pull requests stop
  conflicting on it. `.github/scripts/changelog-assemble.py <version>` folds them in before a tag (`--check` validates
  them; CI runs it), and the release workflow refuses a tag while fragments remain. See `changelog.d/README.md`.
- The two-builders page check opens its pages together instead of one after another, because a page already drawing starves one that is still loading (about 50 s against 10 s), and reopens a page that does not draw in 2 minutes. A failure says what the page was doing and where the browser's CPU went. The check no longer depends on the page answering to give up: a renderer that hung outright left Playwright's waits pending for good, so the step ran to its time limit in silence. Its own timers now fail a stalled step and name it.
- The placement check's touch confirmations (demolish, take a road away) now tap back to back at the place the first tap found. On a slow runner each round trip to the page took seconds, so the confirming tap came after the page had dropped the pick (it does so after 5 s) and only picked again, however often it was retried.
- The placement check taps a touch demolish again when a slow runner lets the first tap's pick lapse, instead of waiting two minutes for an answer to a command that was never sent.
- The check that the past plays forward and joins live waits until the frames around the join are drawn instead of a fixed 1.5 s, so a software renderer at a few frames a second no longer fails it.

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
