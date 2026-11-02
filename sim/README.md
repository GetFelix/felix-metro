# sim

The authority for each city. It builds the city from its seed, steps every district in
lockstep and commits one record per district per tick to `metro.events.<city>`. The
records and the rules behind them are in `core/`; [docs/design.md](../docs/design.md)
says how they fit together.

## Run

```sh
SIM_CITIES=harbor,pinecrest:4 \
SIM_FELIX_TOKEN_FILE=/path/to/sim.token \
SIM_FELIX_CA_FILE=/path/to/broker-cert.pem \
cargo run -p felix-metro-sim
```

| Variable | Default | |
|---|---|---|
| `SIM_CITIES` | required | `name` or `name:districts`, comma or space separated. The name is the seed, and `districts` is how many districts a side has (2 by default) |
| `SIM_ON_DEMAND` | none | cities in the same format whose streams exist but that stay idle, and unlisted, until `POST /cities/<name>/start` on the control endpoint. A city that starts is written to the registry, `metro.cities`, as it does |
| `SIM_FELIX_BROKERS` | `127.0.0.1:5000` | `host:port`, comma separated |
| `SIM_FELIX_SERVER_NAME` | `localhost` | name the broker's certificate is checked against |
| `SIM_FELIX_CA_FILE` | platform store | PEM certificates to trust for the broker |
| `SIM_FELIX_TOKEN_FILE` | required | the sim's Felix token |
| `SIM_TENANT`, `SIM_NAMESPACE` | `metro`, `default` | |
| `SIM_TICKS_PER_SECOND` | `4` | the speed of a new city: 0 (paused), 4, 8 or 16; a tick is 15 seconds of city time at any speed. A city with history keeps the speed it was left at |
| `SIM_WARMUP_HOURS` | `40` | city hours of ticks a city with no history commits as fast as the log takes them before it goes live, so it starts at 16:00 on day 2 with history behind it; 0 starts at midnight. A city that starts paused, or already has records, skips it |
| `SIM_CONTROL_ADDR` | `127.0.0.1:8090` | where the speed endpoint listens; loopback only, it has no authentication |

## Speed

The speed is a target rate in ticks per second: 0 (paused), 4, 8 or 16. Change it while
the sim runs:

```sh
curl -X PUT -d 16 http://127.0.0.1:8090/cities/harbor/speed   # 4x
curl -X PUT -d 0  http://127.0.0.1:8090/cities/harbor/speed   # pause
curl http://127.0.0.1:8090/cities/harbor/speed
```

The change lands on the next tick: its header carries the new speed and every district's
record for it holds a `speed` event. A pause commits that tick as the last one, then no
records are written until a resume, which continues at the next tick with no burst. A
city started with `SIM_TICKS_PER_SECOND=0` waits for its first resume. The endpoint is
for operators. A builder's `speed` command does the same through the command stream.

`GET /cities/<name>/warmup` answers `warming` while a new city is committing its warm-up and
`live` after; `dev/up.sh` waits for `live` on every city.

A city is listed in the registry once it is live.

The endpoint binds loopback only, so in a container it is reached with `exec` or a port-forward from inside the container's network namespace, not through published ports.

## Commands

The sim follows `metro.commands.<city>`, from the start for a new city and from where it stopped reading after a restart (see Restart). The gateway
prefixes each record with the publisher's principal (`stamp_sender`); the sim hashes it
(FNV-1a, 64 bits) and keeps the hash with the command, so the log never holds the
principal itself.

Commands are read in stream order and applied before the next tick is stepped, up to 256
a tick, so that tick's records carry them and its keyframe shows the result. Each is
recorded as a `command` event (hash, builder name, id, result) in the district it touched,
followed by `built` or `demolished`. A refusal has a result code and nothing else, and the
city steps exactly as if it had not been sent. A command with no district, such as a
malformed record or an unknown lot, is recorded in district 0.

| Command | Applied when | Refused with |
|---|---|---|
| `build` | the lot is bare or holds only trees and props, no resident goes there, the kind is a building and the rotation 0 to 3 | unknown lot, bad kind, occupied, in use |
| `demolish` | the lot has a building no resident's schedule uses | unknown lot, empty, in use |
| `speed` | 0, 4, 8 or 16; a paused city resumes on a nonzero one | bad speed |
| `place road`, `zone`, `fork` | not yet | unsupported |

The result codes are in `core/src/record.rs`. A paused city holds the commands it reads
until a `speed` command or the operator resumes it.

## The registry

Every city, when it starts, writes a `created` record (name, seed, districts a side, wall time) to
`metro.cities`, the one-shard stream pages follow for their list of cities. A page lists a name once,
so a repeated record is harmless. `SIM_ON_DEMAND` is how a city comes into being while pages are
open; with the dev stack, `dev/city.sh lakeside` does it.

## Shards

District `i` lives on shard `i` of `metro.events.<city>`. The sim names the shard in
every commit and state read (`commit_if_on_shard`, `state_get_on_shard`), so it does
not depend on how the stream hashes entity keys, and the commit's entity key
(`d<NN>`) is only a label. Anything else that reads a district, such as the web client
through the gateway, names the shard the same way: `read`, `subscribe` and
`state_get` all take a `shard`. This needs a broker that advertises explicit shards
(Felix 0.6.1 or later) and, for the page, a gateway with the `shards` feature (0.8.0
for `state_get`).

The sim refuses to start on a stream with fewer shards than the city has districts.
Changing a stream's shard count later is unsupported: create a new city instead.

Each city needs its stream `metro.events.<city>` with a shard for every district,
and its command stream `metro.commands.<city>`. Create them together: a new city
reads its command stream from the start, so commands left in a stream from an
earlier life of the city would run on the new one.

The log reports every five seconds per city: ticks committed, rate, p50, p99 and max
time from stepping a tick to the last district's answer, ticks that ran late, and
commits sent again.

## Restart

Stop the sim and start it again and each city goes on from the next tick, with everything builders built
and everyone where they were. The city keeps its speed (a paused city stays paused), nothing warms up again, and no
tick is repeated or missing. You can try it on the development stack, which keeps the broker's log when only the
sim restarts:

```sh
docker compose -f dev/compose.yml restart sim   # podman compose the same
docker compose -f dev/compose.yml logs sim | grep "resumed from its log"
```

The sim reads each district's newest keyframe and the records after it (the `keyframe` state key points at the
keyframe), rebuilds the city from them and runs on. [docs/design.md](../docs/design.md#restart) says how, with a
diagram. What to know when you run it:

- **Commands are not lost or repeated.** Every tick that applies commands, and every keyframe tick, records a
  `command_cursor` event: the offset on `metro.commands.<city>` the sim reads next. The command follower opens its
  subscription there, so a command sent while the sim was down runs when it comes back, and none runs twice. A new city
  reads the command stream from the start. A log written before the cursor existed follows the stream's tail.
- **A tick killed halfway is finished.** Districts commit a tick one by one, so a kill can leave some districts a tick
  ahead. The restart commits that tick to the districts that lack it.
- **A killed warm-up carries on live** from where its districts stopped, with less history than a finished one.
- **The speed comes from the log.** `SIM_TICKS_PER_SECOND` is only the speed of a new city.
- **A log it cannot trust stops the sim** with a message. That is a district with a record but no keyframe, ticks that
  are not consecutive, or a resident on the road in a keyframe whose `trip` event is missing or disagrees. Fix or remove
  the log; the sim does not guess.

## Test

`cargo test -p felix-metro-sim` runs the unit tests with no broker. The test in
`tests/day.rs` runs a city for a simulated day against a broker and reads the log back;
it is ignored unless asked for, and so is the restart test in the same file (it needs its
own empty city, `METRO_TEST_RESTART_CITY`, `phoenix` by default). `ci/up.sh` starts the broker
they need (Docker or Podman), and the `sim` job in CI does the same:

```sh
sim/ci/up.sh
METRO_TEST_CA_FILE=$PWD/sim/ci/state/broker-cert.pem \
METRO_TEST_TOKEN_FILE=$PWD/sim/ci/state/sim.token \
cargo test -p felix-metro-sim --test day -- --ignored --nocapture
```
