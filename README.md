<p align="center"><img src="docs/brand/felix-metro-mark.png" alt="Felix Metro" width="200"></p>

# Felix Metro

A 3D city simulator that runs in the browser, built on
[Felix](https://github.com/GetFelix/felix). Everything that happens in the city
is stored in durable Felix streams, so you can scrub back to any earlier moment
and play forward from there.

> **Status:** design stage. `core/` generates a city from a seed; nothing is simulated yet. The [style frame](prototype/style-frame.html) shows the look. The plan is in
> [docs/design.md](docs/design.md) and the work is tracked in
> [milestones](https://github.com/GetFelix/felix-metro/milestones).

| Day | Night |
|---|---|
| ![Felix Metro style frame at noon](docs/screenshots/style-frame-day.jpg?v=2) | ![Felix Metro style frame at night](docs/screenshots/style-frame-night.jpg?v=2) |

## What you will be able to do

- Watch a generated city go about its day in 3D: residents commute, shop and go home, and the sun rises and sets
- Drag the timeline back to any moment the log holds and see the city exactly as it was
- Let go and watch it play forward and catch up to live
- Follow one resident or car through their day
- Place roads, zones and buildings, with every change recorded with who made it
- Fork the city at a past moment and compare the two timelines side by side

## Felix features it uses

| Need | Felix feature |
|---|---|
| A district's history, in order | A durable stream, one shard per district |
| Each tick written atomically, with its offset | `commit` |
| Only one simulation writes a city | `publish_if` / `commit` expected offset |
| The newest keyframe | Stream state (`state_get`) |
| Loading a past moment | Bounded range reads (`read`) |
| Playing forward into live | Subscribe from an offset, with no gap |
| Browsers | [felix-gateway](https://github.com/GetFelix/felix-gateway) |
| Who built what | Sender stamp on the command stream |

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

| M | Milestone | State |
|---|---|---|
| 0 | The look, locked | Planned |
| 1 | A live city | Planned |
| 2 | Time travel | Planned |
| 3 | Follow a life | Planned |
| 4 | Build | Planned |
| 5 | Branching timelines | Planned |
| 6 | Scale and failover | Planned |
| 7 | Self-hosting | Planned |

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
cities `harbor` and `pinecrest`. It returns once a probe has seen a tick on every
district of both cities arrive through the gateway, and prints the web app's address,
<http://127.0.0.1:8088>. The stack keeps no state between runs: `dev/up.sh` starts it
over each time. Stop it with `docker compose -f dev/compose.yml down --volumes`
(`podman compose` the same).

To watch ticks arrive the way a browser gets them, through the gateway (needs Node 22):

```sh
node dev/check-ticks.mjs harbor pinecrest
```

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
