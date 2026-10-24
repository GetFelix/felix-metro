<p align="center"><img src="docs/brand/felix-metro-mark.png" alt="Felix Metro" width="200"></p>

# Felix Metro

A 3D city simulator that runs in the browser, built on
[Felix](https://github.com/GetFelix/felix). Everything that happens in the city
is stored in durable Felix streams, so you can scrub back to any earlier moment
and play forward from there.

> **Status:** a live city runs end to end. The sim steps it, the browser draws it live, and a city picker switches between cities. Opening the city at an earlier moment works (`/?at=<tick>#harbor` draws it there, paused); the timeline bar scrubs the city back through the hours it still holds (drag the handle, or step with `←` and `→`, `Shift` for an hour); Space plays forward from there at the city's speed and Back to live races to the live city and joins it with no gap and no reload; following a resident and building are not built yet. The [style frame](prototype/style-frame.html) shows the look. The plan is in
> [docs/design.md](docs/design.md) and the work is tracked in
> [milestones](https://github.com/GetFelix/felix-metro/milestones).

| Day                                                                          | Night                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![Felix Metro style frame at noon](docs/screenshots/style-frame-day.jpg?v=2) | ![Felix Metro style frame at night](docs/screenshots/style-frame-night.jpg?v=2) |

## What you will be able to do

- Watch a generated city go about its day in 3D: residents commute, shop and go home, and the sun rises and sets. Rush hour at 08:00 and 17:15 puts up to about 40 cars and 10 walkers on the streets of the busiest district, and about 100 cars across the harbor city at 2 by 2 (522 residents; `cargo run --release -p felix-metro-core --example density -- harbor 2` prints the counts). The log averages about 8 KB/s over a day at 20,000 residents and peaks near 17 KB/s in the busiest minute of the rush, from the hourly snapshots of each district landing together, which #95 tracks (`cargo test -p felix-metro-sim --release report_load -- --ignored --nocapture` measures it).
- Drag the timeline back to any moment the log holds and see the city exactly as it was
- Let go and watch it play forward and catch up to live
- Follow one resident or car through their day
- Place roads, zones and buildings, with every change recorded with who made it
- Fork the city at a past moment and compare the two timelines side by side

## Felix features it uses

| Need                                          | Felix feature                                              |
| --------------------------------------------- | ---------------------------------------------------------- |
| A district's history, in order                | A durable stream, one shard per district                   |
| Each tick written atomically, with its offset | `commit`                                                   |
| Only one simulation writes a city             | `publish_if` / `commit` expected offset                    |
| The newest keyframe                           | Stream state (`state_get`)                                 |
| Loading a past moment                         | Bounded range reads (`read`)                               |
| Playing forward into live                     | Subscribe from an offset, with no gap                      |
| Browsers                                      | [felix-gateway](https://github.com/GetFelix/felix-gateway) |
| Who built what                                | Sender stamp on the command stream                         |

## How it works

A simulation process steps every district of a city in ticks of 15 seconds of
city time, four a second at normal speed, so a city day takes 24 minutes. It can
be paused or run at 2× and 4×. Each tick it commits one record per district with that
tick's events, such as a resident leaving home on a route or a building going
up. It does not write positions. The browser moves cars along their routes
itself. Every city hour each district also commits a keyframe, its full state.

To show an earlier moment, the browser reads each district's nearest keyframe
and the events after it, up to that moment. To play forward, it subscribes from
there. [docs/design.md](docs/design.md) has the details.

## Status

| M   | Milestone           | State                                                                                                                                                                                                                                                                         |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | The look, locked    | In progress: style frame, assets, daylight, post-processing and quality tiers done; instanced traffic, the UI shell and camera controls open                                                                                                                                  |
| 1   | A live city         | Done                                                                                                                                                                                                                                                                          |
| 2   | Time travel         | In progress: keyframes, seeking, the timeline scrubber and rewind then follow done                                                                                                                                                                                            |
| 3   | Follow a life       | Planned                                                                                                                                                                                                                                                                       |
| 4   | Build               | In progress: the sim applies build, demolish and speed commands and records who sent them, and the page animates a building going up (scaffold) or coming down (dust) over 8 ticks, backwards when you rewind; placement tools in the page, roads and zones are not built yet |
| 5   | Branching timelines | Planned                                                                                                                                                                                                                                                                       |
| 6   | Scale and failover  | Planned                                                                                                                                                                                                                                                                       |
| 7   | Self-hosting        | Planned                                                                                                                                                                                                                                                                       |

What runs today: the sim, the dev stack and a browser page that shows a city live, with
cars and walkers moving in time with the sim and the sun following the tick. The page
opens on a loading screen that fills in district by district, then drifts down onto the
city. If the connection drops, a `Reconnecting…` pill shows, the city keeps moving, and
the page reads what it missed from the log and carries on in order. If retention has
already dropped what it missed, it restarts that district from the newest keyframe left.
A city the gateway refuses (a misspelled name, or no access) shows a message instead of
retrying. The city name in the top left opens a list of every city. Following a resident and the page's own
building tools are not built yet; a command published to the city's command stream by any client with a
builder's token is applied by the sim and shows up in the page, rising over 8 ticks of city time inside a scaffold (a demolished building scales down in a puff of dust). Rewind through it and it comes down again; the low quality tier skips the scaffold and the dust.

## Recording the clip

`web/scripts/clip-local.mjs` records it on this machine's GPU. It takes the backend from a
release bundle in Podman (nothing is built), serves this checkout's page with Vite, draws
the city in a visible Edge window one frame at a time and encodes the frames with ffmpeg:

```
cd web && npm run core
node scripts/clip-local.mjs harbor 30 ~/clips      # city, seconds, output directory
CLIP_SIM=native node scripts/clip-local.mjs ...    # this checkout's sim in place of the bundle's image
```

The page draws frame by frame only under `?capture&trace`, with the camera and the city's
tick following a path the script sets, so the clip is smooth however long a frame takes. The
shots are the street at rush hour, the evening coming on, the timeline dragged back to the
morning, played forward and back to live. A playback is stepped one video frame at a time
in capture mode, so the clip does not depend on how long a frame takes to draw. `density.json` and `shots.csv` count the cars and walkers drawn. Everything
the script starts is stopped when it ends. The sim has to be native (`CLIP_SIM=native`)
for any sim change that is not in the release bundle's image.

The bundle's ports are moved so it runs beside another Felix stack: broker 5100/udp, 28080,
18443, and the gateway on `CLIP_GATEWAY_PORT` (default 18787, which Vite proxies through
`FELIX_GATEWAY_PORT`). The native sim's control address is `CLIP_SIM_PORT` (default 18090).
The run stops if 5173 is already in use.

The Clip workflow (`.github/workflows/clip.yml`, run by hand) does the same on a CI runner in
software GL, as a fallback; it fails when no mp4 is written. `cargo run --release --example
density -- harbor 2` in `core/` prints the cars and walkers on the road from the schedules alone.

## Install a release

Each [release](https://github.com/GetFelix/felix-metro/releases) has a compose bundle
that pulls the published images instead of building them. You need Docker or Podman as
described below. The compose bundle runs Felix 0.6.1.

```sh
curl -fsSL https://github.com/GetFelix/felix-metro/releases/download/v0.1.0/felix-metro-compose-0.1.0.tar.gz | tar xz
cd felix-metro-compose-0.1.0
./up.sh
```

It starts the same stack as `dev/up.sh` and returns once the cities are serving. The web
app is at <http://127.0.0.1:8088>. `./speed.sh` and `./city.sh` work as the `dev/` ones
do. `SHA256SUMS` on the release lists a checksum for each download, and
`felix-metro-web-v0.1.0.tar.gz` is the built web app alone.

## Run it locally

You need Docker or Podman (`podman compose` with Docker Compose v2 or podman-compose
1.4 or later as its provider; on macOS run `podman machine start` first).

```sh
dev/up.sh
```

The first run builds the sim and the web app, which takes a few minutes. It starts
Felix (a control plane and one broker as a cluster of one, so a city's stream can
have a shard per district), a stand-in sign-in provider, the
[gateway](https://github.com/GetFelix/felix-gateway), the sim and the web app, with the
cities `harbor` and `pinecrest` (and `lakeside`, which the sim holds back, see below). It returns once a probe has seen a tick on every
district of both cities arrive through the gateway, and prints the web app's address,
<http://127.0.0.1:8088>. The stack keeps no state between runs: `dev/up.sh` starts it
over each time. Stop it with `docker compose -f dev/compose.yml down --volumes`
(`podman compose` the same).

Open <http://127.0.0.1:8088/#harbor>: the page signs in as `viewer` at the stand-in
provider, follows the city through the gateway and draws its residents driving and
walking in time with the sim, with the sun following the tick. A city starts at
midnight, so for traffic run `dev/speed.sh harbor 16` and give it a few minutes
(the morning commute is around 06:00). Without a gateway the page draws the
city alone.

Click the city name in the top left to switch cities, or open `/#pinecrest` (any name
in the list) directly. Choosing a city opens its page afresh, so the old city's
connections close with the old page. The list comes from the registry, which the sim
writes to as each city starts, so a city that starts while the page is open appears in the
list without a reload (a city started again at another size is listed at the latest one).
If a city cannot open its streams when you start it, `dev/city.sh` fails with the reason
and the sim keeps running. The stack seeds a third city, `lakeside`, and the sim keeps it idle
and unlisted until you start it:

```sh
dev/city.sh lakeside
```

To see the page ride out a dropped connection, stop the gateway for a few seconds and
start it again (the page shows `Reconnecting…` and carries on):

```sh
dev/gateway.sh stop
dev/gateway.sh start
```

`dev/gateway.sh recreate` brings the gateway back at a new address instead; the web
container looks the name up again, so the page reconnects through it.

To watch ticks arrive the way a browser gets them, through the gateway (needs Node 22):

```sh
node dev/check-ticks.mjs harbor pinecrest
```

To build the way a mayor does, from a plain client with no browser (needs Node 22), publish
commands through the gateway and watch them come back as events:

```sh
node dev/check-commands.mjs pinecrest
```

It signs in as `mayor` (`GET /token?sub=mayor` on the dev IdP, no `Origin` header),
publishes `build` commands until one takes, and checks that the district of that lot
records the command with its sender and the `built` event within a tick. It then sends
commands the sim must refuse and checks each is recorded with its reason and changes
nothing. It then waits for the district's next keyframe (up to a minute at the default speed)
and checks it lists the built lot, and demolishes what it built. A `viewer` cannot publish.

The sim runs at 4 ticks a second. Its speed endpoint accepts only loopback, so it is
not published; `dev/speed.sh` runs `curl` inside the sim's container:

```sh
dev/speed.sh harbor 16   # 0 pauses, 4, 8 or 16
dev/speed.sh harbor      # show it
```

`dev/seed.mjs` sets up the tenant and each city's streams, and the roles that
`viewer` (watch) and `mayor` (watch and build) sign in with. `sim/ci/` runs the same
seed against a broker for the sim's integration test.

## Documentation

- [docs/design.md](docs/design.md): the design, data model and build order
- [docs/art.md](docs/art.md): art direction, the asset packs and the style frame
- [Felix docs](https://docs.getfelix.dev/)

## Felix version

The Felix release this repo builds on is in [`.felix-version`](.felix-version).
When Felix publishes a release, a bot opens a "chore: use Felix <version>" PR
that moves every pin listed in [`.github/felix-bump.sh`](.github/felix-bump.sh)
and the lockfiles, and merges it once CI passes. Prereleases are skipped.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
