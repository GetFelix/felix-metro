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
| `SIM_FELIX_BROKERS` | `127.0.0.1:5000` | `host:port`, comma separated |
| `SIM_FELIX_SERVER_NAME` | `localhost` | name the broker's certificate is checked against |
| `SIM_FELIX_CA_FILE` | platform store | PEM certificates to trust for the broker |
| `SIM_FELIX_TOKEN_FILE` | required | the sim's Felix token |
| `SIM_TENANT`, `SIM_NAMESPACE` | `metro`, `default` | |
| `SIM_TICKS_PER_SECOND` | `4` | the city's speed at start: 0 (paused), 4, 8 or 16; a tick is 15 seconds of city time at any speed |
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
for operators; the builders' `speed` command will replace it.

## Entity keys

District `i` lives on shard `i` of `metro.events.<city>`. Felix picks a shard from
the entity key's hash, so plain `d00` to `d03` can put two districts on one shard and
leave another empty. The sim salts them: a district's key is `d<NN>`, or `d<NN>.<n>`
for the first `n` where the key routes to shard `NN`. The hash depends on the stream's
routing mode (`modulo` or `jump_hash`), which the sim asks Felix for at start.

Anything that publishes to or reads a district by key, such as the web client or a
gateway subscriber, must use the same keys. `felix_metro_core::district_key(district,
shards, routing)` computes them, and the WebAssembly build exports it as `districtKey`.
Reading a shard by number needs no key.

Changing a stream's shard count changes the keys and moves districts between shards,
so it is unsupported: create a new city instead.

Each city needs its stream `metro.events.<city>` with a shard for every district,
empty. A city whose stream already has records is not resumed: the sim stops.

The log reports every five seconds per city: ticks committed, rate, p50, p99 and max
time from stepping a tick to the last district's answer, ticks that ran late, and
commits sent again.

## Test

`cargo test -p felix-metro-sim` runs the unit tests with no broker. The test in
`tests/day.rs` runs a city for a simulated day against a broker and reads the log back;
it is ignored unless asked for. `ci/up.sh` starts the broker it needs (Docker or
Podman), and the `sim` job in CI does the same:

```sh
sim/ci/up.sh
METRO_TEST_CA_FILE=$PWD/sim/ci/state/broker-cert.pem \
METRO_TEST_TOKEN_FILE=$PWD/sim/ci/state/sim.token \
cargo test -p felix-metro-sim --test day -- --ignored --nocapture
```
