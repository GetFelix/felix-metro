# Felix Metro design

A city simulator that runs in the browser in 3D, whose entire backend is
[Felix](https://github.com/GetFelix/felix). Low-poly buildings, roads, cars and
people go about a day that runs about 24 minutes. Everything that happens is
written to durable Felix streams, and the headline feature comes from that: drag
the timeline back and the city goes back with it. The sun runs backwards, cars
reverse along their routes, buildings come down. Let go and the city plays
forward from that moment and catches up to live with no gap.

[felix-arena](https://github.com/GetFelix/felix-arena) shows a log being the
live feed and the replay at once, over five-minute matches. Felix Metro shows
the same thing over a long history, where seeking matters more than following:
"show me 08:15 three days ago" has to be quick, and the log has to stay small
enough to keep days of it.

**In scope**

- One procedurally generated city per name, from a seed: a road grid, zoned districts, buildings, residents and their cars
- Residents with daily schedules (home, commute, work, errands, home) driving and walking on the road graph
- Live view in 3D with a tilted, orbitable camera, a day/night cycle and a tilt-shift miniature look
- A timeline to scrub back to any moment the log still holds, with markers for notable events
- Following one resident or car through their day
- Building: placing and removing roads, zones and buildings as commands the simulation applies
- Branching: forking the city at a past moment into a new timeline and comparing the two

**Out of scope**

- Economy depth (budgets, taxes, land value). The city has a few headline numbers, not a finance model
- Utilities, disasters, public transport networks beyond what a milestone names
- Accurate traffic modelling. Congestion is simple and plausible, not a research model
- Anything that needs a second datastore. If a feature cannot be expressed in streams, stream state, caches and counters, it is out

## What it has to demonstrate

1. **Rewind to any moment, quickly.** From any position on the timeline, the city is drawn at that moment in under a second.
2. **Rewind, then follow live with no gap.** Playing forward from the past joins live delivery without a missing or repeated event.
3. **A small log.** A city of 20,000 residents writes on the order of 10 KB/s, so a week of history is a few gigabytes on one broker. Today's rush peaks near 17 KB/s, see #95.
4. **One authority that survives a restart.** The simulation is fenced at the broker, and a replacement picks up from the log where the last one stopped.
5. **Forks are cheap.** A branch starts from a keyframe of the parent and owes it nothing after that.

## Architecture

```mermaid
flowchart LR
    V1["Viewer browser<br/>render + interpolate"] --> GW["felix-gateway<br/>WebSocket to QUIC"]
    V2["Builder browser"] --> GW
    GW -->|QUIC| BR["Felix brokers<br/>district logs, commands"]
    GW -->|token exchange| CP["Control plane<br/>OIDC + metadata"]
    SIM["Simulation<br/>authority per city"] -->|QUIC| BR
```

| Component     | Language                                                   | Holds state?                     | Responsibility                                                           |
| ------------- | ---------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Client        | TypeScript, Three.js, `core` as WebAssembly                | A view of the city at one moment | Render, interpolate motion along routes, seek, timeline                  |
| Gateway       | [felix-gateway](https://github.com/GetFelix/felix-gateway) | No                               | Browser transport, token narrowing to one city, sender stamp on commands |
| Simulation    | Rust, `core` + `felix-client`                              | Yes, recoverable from the log    | Step every district of a city in lockstep, commit each tick              |
| Brokers       | Felix                                                      | Yes, authoritative               | District logs, keyframe pointers, command stream                         |
| Control plane | Felix                                                      | Yes, metadata                    | Token exchange, city registration, RBAC                                  |

### Shared rules in `core`

City generation from a seed, the road graph, schedules, routing, the record
encoding and route interpolation live in one Rust crate with no I/O. The sim
links it natively and the browser loads it as WebAssembly. The browser does not
simulate; it uses `core` to decode records, rebuild the road graph from the
seed and keyframes, and move a car along its route between events. Integer
arithmetic throughout, as in felix-arena, so the two builds agree exactly.

### City layout

`City::generate(seed, districts_per_side)` builds the same city on every platform from integer arithmetic. Every random choice is a stateless hash of the seed, a stage and the place it is made, so a small change stays local and nothing depends on the order things are drawn. The city is `12 * d + 1` tiles across, the road along each far edge included. Districts are 12 by 12 tiles and only shard the city; roads and blocks ignore them.

- **Arterials** cross the whole city at hashed spacing of 7 to 12 tiles. Segments on them are avenues (faster); every other road is a street.
- **Blocks** come from splitting the space between arterials with streets, each split keyed on the rectangle it cuts. The block size depends on the zone: small downtown, longer in the suburbs, industrial superblocks with a yard inside. A few splits are skipped, a few suburban streets stop short as dead ends, and a union-find pass keeps one connected road graph.
- **Land value** (0 to 255) falls off with distance from the main centre and from one or two secondary centres at arterial crossings, rises along arterials and by the water, and carries low-frequency noise. Downtown sits at the peaks, commercial where value is middling or along an arterial, suburbs elsewhere, and industry in a hashed band along an edge or the waterfront. One block in each district is a park. Buildings are taller where value is higher, with jitter; corner lots get the bigger and taller models.
- **Lots** are the non-road tiles. A lot beside a road faces it (shops prefer the arterial) and has a door, a segment and an offset along it, for residents to route to. A tile with no road beside it is filler (trees or a plaza prop) with no door and no home or business. The Felix tower stands on the downtown lot nearest the main centre.
- **The development area** is 14 to 16 lots (fewer in a tiny city) that start empty, so a builder has bare ground to raise buildings on. Almost every other lot is in some resident's day, and the sim refuses to change those. The generator tries windows of 5 to 7 tiles a side that sit inside one district, and takes the one whose lots with a door (never the tower or park land) number 14 to 16, preferring the most suburban, with a hash of the seed and place breaking ties. The area is the lots with a door in that window, emitted with a tree kind and listed in `City::development`, in the JSON as `development` and in `City::hash`. No road changes, so routes are unaffected. Residents never pick them as home, shop, park or work, and the browser draws them as bare earth until something is built. In `harbor` at 2 by 2 it is 14 lots in district 1; in `pinecrest`, 15 in district 3.
- **Road pieces:** each road tile reports its piece (straight, corner, T, cross or end), its neighbour mask and a rotation, for the browser to draw.
- **Water** is a mask over the finished layout. Some seeds, `harbor` among them, have a ragged shoreline 3 to 6 tiles deep along one edge. The edge is reserved whether or not the seed is wet, and centres, the tower and parks keep clear of it, so the layout never depends on the water. Tiles under water lose their road and lot; a lot whose road went under is flooded with it, and so is any road the water cut off from the rest. Everything else is identical to the dry city.

Seeds are parts of 1 to 32 characters of `a-z`, `0-9` and `-`, joined by `~` for forks. Each lot's building kind is an index into a table in `core` that names a Kenney pack and model. Street, business and resident names come from built-in lists. `City::hash` is an FNV-1a hash of the whole layout, so the sim and the browser can check they generated the same city. `cargo run -p felix-metro-core --example map -- harbor 2` prints a city as ASCII.

### Residents, schedules and routes

`core` also draws the people. A city has six residents for each suburban lot with a door, counting the development area's lots so setting it aside does not shrink the population (the people are spread over the homes that remain), and resident `i` is fixed by the seed and `i`: an archetype (office worker, shift worker, shopkeeper, student, retiree or night worker), a home, and a workplace that is the nearest of three random picks from the places that suit the archetype. Times are jittered per resident, and people leave early enough by a rough travel estimate to arrive at their usual time. Office workers arrive between 07:45 and 08:15 and leave between 17:00 and 17:30; shopkeepers arrive between 07:45 and 08:30 and leave between 17:00 and 18:30, and office workers walk or drive to the shops at lunch, so the roads fill in two bursts a day rather than a trickle. Shops and parks are the nearest of eight random picks, so errands are mostly short enough to walk, and half the retirees go out in the afternoon rush instead of the morning. In the harbor city at 2 by 2 districts that is 522 residents; the road holds up to 91 cars and 20 walkers at once, the busiest district up to 44 cars and 11 walkers, 9 cars on the busiest segment, and the 08:00 and 17:15 frames show about 31 to 35 cars in the busiest district. `cargo run --release -p felix-metro-core --example density -- harbor 2` prints these.

A day is a cycle of blocks, each a lot and the tick of the day they leave it. The last block's trip returns to the first, so the day closes. A night worker's day starts at work, because they are still there at midnight. A trip leaves at its scheduled tick, or on arrival if the last one ran late.

A route is an A\* search over the road graph. Costs are integer milliseconds of travel, a door sits partway along its segment so the search starts and ends from both ends of it, and the heuristic is the fewest tiles between nodes at the fastest road speed. The sim passes in last tick's vehicle count for each segment. A segment holds three cars a tile before it slows, then runs at that share of its speed down to a fifth, and the trip drives it at that speed, so the route chosen is the route taken. A route of 4 tiles or less is walked at 0.3 tiles a second.

A trip is its legs, each with a speed percentage, and a depart tick; every leg's end tick follows from them. `position_at(tick)` interpolates in integers, so it never moves backwards along the route and gives the same answer natively and in WebAssembly.

### Districts are shards

A city is a grid of districts, and each district is one shard of the city's
event stream. The sim routes every commit with the district as its entity key.
This keeps each district's history in order on its own shard and spreads a big
city over brokers.

Felix maps an entity key to a shard by hashing it, and the keys `d00` to `d03`
do not land on four different shards of a four-shard stream. So district `i`
commits with `d<NN>` where that hashes to shard `i`, and with `d<NN>.<n>` for
the first `n` that does where it does not. The stream needs a shard for every
district, and district `i` is always shard `i`.

One sim task steps all districts of a city in lockstep. Each tick it commits one
record per district, in parallel, and waits for all of them before the next
tick. Because one process owns every district, a resident crossing a district
boundary is a `left` event in one tick record and an `entered` event in the
other, in the same tick. Splitting one city across several sim processes is
not needed at the target scale and is left out.

## Time

- **Each tick is 15 seconds of city time**, so a city day is 5,760 ticks. At normal speed the sim steps at 4 Hz and a day takes 24 real minutes: short enough that a few minutes of watching shows rush hour and nightfall.
- **Speed changes the tick rate, not the tick.** Pause, 1×, 2× and 4× step at 0, 4, 8 and 16 Hz. A tick always covers the same city time, so the tick number stays a linear clock and seeking and interpolation never need to know the speed. The log costs the same per city day at any speed; only its rate per real second changes.
- **Speed belongs to the city, not the viewer.** It is set on the sim, written in every tick header, and changed with a `speed` event, so a seek can turn wall time into ticks across speed changes. A viewer's playback speed while scrubbing is separate and local.
- **A speed change takes effect between ticks.** The sim reads the requested speed after every district has answered a tick, so the next tick's header carries the new speed and each district's record for it holds a `speed` event; no other tick has one. Changing to 0 commits that tick as the last one (header speed 0), then the clock stops: no records are written while paused and the city clock does not move. A resume continues at the next tick, due at once and at the new rate from then on, with no catch-up burst. Only 0, 4, 8 and 16 are accepted. Seeking goes by tick number and offset, and nothing in `core` reads the speed.
- **The operator sets it** with `SIM_TICKS_PER_SECOND` at start and a loopback-only HTTP endpoint on the sim (`PUT /cities/<name>/speed`). A builder's `speed` command from the command stream does the same, and a nonzero one resumes a paused city.
- **The tick number is the city's clock.** Every record carries it. "The city at 08:15 on day 3" is a tick number, and the city at a tick is every district rewound to that tick.
- **Offsets are per district.** Districts are aligned by tick, never by offset.

## Records

### Events, not positions

A car's position every tick would cost around 4 MB/s for 10,000 cars. The sim
writes decisions instead, and the client works out positions:

| Event                  | Fields                                                                     | Meaning                                    |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `trip`                 | resident, vehicle kind, depart tick, route (segment ids with a speed each) | Leaves now along this route                |
| `replan`               | resident, from segment, new route                                          | A jam or a closed road changed the route   |
| `arrived`              | resident, lot                                                              | Reached a building                         |
| `activity`             | resident, kind (sleep, work, shop, ...), until tick                        | What they are doing inside                 |
| `left` / `entered`     | resident, other district, vehicle state with the route left                | Crossed into another district              |
| `built` / `demolished` | lot, building kind, rotation                                               | A building changed                         |
| `road`                 | segment, change (closed, opened, added, removed)                           | A road changed                             |
| `command`              | principal hash, builder name, command id, result                           | A builder's command was applied or refused |
| `speed`                | ticks per second                                                           | The city's speed changed; 0 is paused      |

A route is its segment ids from the road graph (`u32`) and one speed byte per
segment, a percentage of the segment class's speed. A trip of 12 segments is 36
bytes, so a resident making five or six trips a city day, in a city of 20,000
residents, writes under 5 KB/s of events at normal speed. Measured on the harbor city, a resident costs 0.15 B/s of events at 4 ticks a second, which is 3 KB/s at 20,000, plus the 31-byte header of each district's record every tick (2 KB/s for 16 districts).

### Byte layouts

Every record starts with a kind byte, and a layout change gets a new kind.
Integers are little-endian. A varint is LEB128 in its shortest form (a padded
one is refused, so a retried tick is the same bytes), and a delta is a zigzag
varint of the difference from the previous id in the list, so lists need no
order. A string is a length byte and UTF-8, at most 64 bytes; encoding refuses a
longer one instead of cutting it. `core/src/record.rs` encodes and decodes all
of them.

Decoding returns an error for truncated or trailing bytes, an unknown kind or
header flag bit, an out-of-range value, a string over 64 bytes or bad UTF-8,
and a body shorter than its tag's fields. Flag bits choose the layout, so
they stay strict, as in the wire protocol. Events and a keyframe's resident
entries are framed instead (a tag, a varint body length and the body), so an
older reader skips a tag it does not know and keeps the rest of the tick, and
ignores bytes appended to a body it does know. A field can therefore be added
to the end of an event without a new kind.

| Kind | Record                                        |
| ---- | --------------------------------------------- |
| 1    | Tick record, a district's commit for one tick |
| 2    | Command, on `metro.commands.<city>`           |
| 3    | Registry entry, on `metro.cities`             |

### Tick records

Each district commits one record per tick. A tick with no events is still
committed, so every tick has a record in every district. Seeking depends on
that.

| Offset | Size | Field                                                                       |
| ------ | ---- | --------------------------------------------------------------------------- |
| 0      | 1    | kind, 1                                                                     |
| 1      | 4    | `epoch`, the sim's term; a new sim takes the last plus one                  |
| 5      | 2    | `district`                                                                  |
| 7      | 4    | `tick`                                                                      |
| 11     | 1    | `speed`, ticks per second                                                   |
| 12     | 1    | `flags`; bit 0 is a keyframe, other bits are refused                        |
| 13     | 8    | `keyframe_offset`, the district's latest keyframe (a keyframe names itself) |
| 21     | 8    | `wall_us`, microseconds since the Unix epoch at commit                      |
| 29     | 2    | `events`, the number of events                                              |
| 31     |      | the keyframe if bit 0 is set, then the events                               |

An event is a tag byte, a varint body length and the fields below. `resident`
is a `u32`. `events` counts every event, including ones a reader skips.

| Tag | Event        | Fields                                       |
| --- | ------------ | -------------------------------------------- |
| 1   | `trip`       | resident, vehicle `u8`, depart `u32`, route  |
| 2   | `replan`     | resident, from segment `u32`, route          |
| 3   | `arrived`    | resident, lot `u32`                          |
| 4   | `activity`   | resident, kind `u8`, until `u32`             |
| 5   | `left`       | resident, district `u16`, vehicle state      |
| 6   | `entered`    | resident, district `u16`, vehicle state      |
| 7   | `built`      | lot `u32`, kind `u16`, rotation `u8`         |
| 8   | `demolished` | lot `u32`, kind `u16`, rotation `u8`         |
| 9   | `road`       | segment `u32`, change `u8`                   |
| 10  | `command`    | principal `u64`, name, id `u32`, result `u8` |
| 11  | `speed`      | ticks per second `u8`                        |

A route is a varint leg count, the segment ids (first as a delta from 0, then
each from the one before), then one speed byte per leg. A vehicle state is kind
`u8`, progress along its first leg in thousandths `u16` (0 to 1000), and a
route.

An activity `kind` is the schedule's activity: 0 home, 1 work, 2 school, 3 shop,
4 leisure. Sleep is not one; a viewer shows a resident at home through the night
as asleep. A vehicle `kind` of 0 is a walker. In a tick, a resident's `arrived`
and `activity` are in the district of the lot they reach, `trip` is in the
district of the lot they leave, and a resident who drives into another district
is `left` there and `entered` here, in the tick the vehicle first is in it.

### Keyframes

Every 240 ticks (one real minute, one city hour) each district commits a
keyframe: a tick record with flag bit 0 set, whose keyframe goes between the
header and the events. A keyframe can be drawn with nothing before it. Its
commit also writes the stream state key `keyframe`, so the newest one is one
`state_get` away, with its offset as the value's version.

| Part      | Contents                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| buildings | varint count; per lot that differs from the generated city: lot delta, kind `u16` (65535 for none), rotation `u8`                                                                                        |
| roads     | varint count; per segment closed or added: segment delta, change `u8`                                                                                                                                    |
| residents | varint count; per resident in the district: id delta, then a framed state: tag `0`, kind `u8`, lot `u32` and until varint (an activity in that lot), or tag `1` and a vehicle state (a trip in progress) |
| counts    | varints: home, at work, on the road, asleep. Home between 22:00 and 06:00 is asleep; work and school are at work; shopping and leisure are in none of them                                               |

Because buildings and roads are diffs against the city the seed generates, the
keyframe of a city nobody has built in carries none of them, and the cost is
the residents.

20,000 residents at about 10 bytes each (measured: a district of 200 residents writes a 1.8 KB keyframe) is about 200 KB per city hour, about
3.4 KB/s. Events, keyframes and record headers together come to about 8.4 KB/s averaged over a day, or under 1 GB a day.

The mean hides the rush. Trips cluster around 08:00 and 17:15, and the hourly keyframe of every district lands on the same tick (08:00 and 17:00 are both on the hour). Measured on a harbor city with 1,260 residents in each of four districts, the same load as 20,000 residents in 16, the busiest minute of the morning rush writes 3.7 KB/s and of the evening rush 4.2 KB/s, which is 14.6 and 16.5 KB/s at 20,000 residents, and one district's busiest minute is 1.5 KB/s. The worst single tick is a district's keyframe, about 20 KB, against under 600 B for a tick without one. `report_load` in `sim/src/world/tests.rs` prints these. Bringing the peak back to the 10 KB/s goal is tracked in #95.
The counts are what the stats sparkline plots.

### Commands and the registry

A command record is the kind byte, a command id `u32`, the builder's display
name, a tag and fields. It carries no principal: the gateway's `stamp_sender`
adds who sent it outside the payload, and the sim copies that principal hash
with the name into the `command` event of the district it touched. The hash is
FNV-1a over the principal's UTF-8 bytes, so the same builder always has the same
hash and the log never holds the principal.

The sim reads the stream from its tail and applies commands in order before it
steps the next tick, at most 256 a tick. That tick's records carry the `command`
event, then what it changed (`built` or `demolished`), in the district of the
lot, and its keyframe already shows the change. A refused command records only
the `command` event, with a result code, and the city steps as if it had not
been sent. A command with no district, such as a malformed record or a lot past
the last, is recorded in district 0.

A paused city holds up to 1,024 commands. Further ones are remembered only as
who sent them and their id, up to another 1,024, and are recorded in district 0
with result 9 once the held commands have run, after the city resumes. The
command that resumes the city is always held. Past 2,048 commands the sim drops
the extra, logging one warning when the dropping starts and a count when the pause ends, because remembering every command would use unbounded
memory while nothing is ticking. A running city reads at most 256 a tick and
never skips a tick for commands.

The operator's endpoint and the `speed` command write one value. The last to
change it wins, a commanded speed stays until someone sets another, and a
`speed` event is recorded once per actual change. The sim reads the operator's
setting right before it applies a tick's commands, so a command applied after it
overrides it, and it reports a commanded speed only if the operator has set
nothing since that read; a newer operator setting is applied on the next tick.
A `speed` command that resumes a paused city is never left waiting behind
commands queued ahead of it: the city keeps working through its queue until it
is empty or paused with no resume in it.

On a restart the sim begins again at tick 0 with the generated city: what
builders built (`World.built`) is not persisted, and the log's older epoch
still shows it. The command follower starts at the stream's tail, so commands sent while the
sim was down are not run. It opens the subscription in the background and
retries every second until the broker accepts it (a broker still electing
leaders refuses at startup), so commands sent before it opens are not seen.
Once open, the Felix client's subscription survives a lost connection or a
moved shard by resubscribing at the offset after the last command it delivered
(or at the tail it first joined, if none yet), so nothing is skipped or
repeated. An error it reports is the last thing that subscription yields: the
follower logs it, waits a second and asks the same subscription again, and if
it then reports the stream closed the follower logs an error naming the city and stops, and the city runs without
builders until the sim restarts.

| Result | Meaning |
|---|---|
| 0 | applied |
| 1 | not a command record |
| 2 | lot or node does not exist |
| 3 | `build` on a lot that has a building |
| 4 | `demolish` on a lot with nothing on it |
| 5 | `build` of a kind that is not a building, or a rotation past 3 |
| 6 | `speed` other than 0, 4, 8 or 16 |
| 7 | not carried out yet: `place road`, `zone` and `fork` |
| 8 | the lot is one residents go to |
| 9 | sent while the city was paused with more commands waiting than it holds; send it again |

Lots residents go to (homes, workplaces, parks) cannot be built over or demolished,
because the schedules that send people there do not change.

The display name comes from the ID token's name claim, chosen client-side, so it
is whatever the builder chose and is shown as given. The record layer only
limits it to 64 bytes. A fork's name is a seed part, 1 to 32 characters of
`a-z`, `0-9` and `-`, and the sim refuses the command (result code) when it is
not. The lineage name `harbor~bridge-closed` that registry records carry must
fit 64 bytes too, so a fork too deep to name is refused the same way.

| Tag | Command    | Fields                               |
| --- | ---------- | ------------------------------------ |
| 1   | place road | node a `u32`, node b `u32`           |
| 2   | zone       | lot `u32`, zone `u8`                 |
| 3   | build      | lot `u32`, kind `u16`, rotation `u8` |
| 4   | demolish   | lot `u32`                            |
| 5   | speed      | ticks per second `u8`                |
| 6   | fork       | tick `u32`, name                     |

A registry record is the kind byte, a tag and fields: `1` created (name, seed,
districts `u16`, `wall_us` `u64`) or `2` forked (name, parent, tick `u32`,
`wall_us` `u64`).

### Ticks are commits

Each tick record is a Felix `commit` on its district's shard, for the same
reasons felix-arena uses it: the answer carries the offset (the next tick
record needs the keyframe's offset), a keyframe and its state pointer land
together, and the sim waits for each answer, so records land in tick order.

Every commit is a `commit_if` at the offset the sim expects the district's shard
to be at, so the sim always knows the offset a record will have. A keyframe
puts that offset in its own `keyframe_offset` and in the `keyframe` state key
in the same commit. A stale sim that comes back after a replacement took over is
refused at the broker instead of writing a second history, and a sim that
starts over a city that already has history stops.

A district that gets no answer is sent the same bytes again at the same
expected offset, after a growing wait. If the shard's tail shows the earlier
send landed, that is the answer. The sim does not move on until every district
has answered, and a slow tick runs late: the next one starts a period after it
ends, so no tick is skipped and none is made up in a burst.

## The live view

The page follows a city through the gateway on one connection, one subscription
per district shard in a slot of its own (`d00`, `d01`, ...). To start it does
what [Seeking](#seeking) does for the newest moment, in an order that cannot
lose a record:

1. Subscribe to every district from live and hold what arrives. Each answer
   says the shard's tail.
2. Read each district's `keyframe` state key. The key is held under the
   district's entity key, which depends on how the stream hashes keys, and
   Felix does not report that to a browser, so the page tries both routings
   and trusts a pointer only when the record it names is that district's
   keyframe.
3. Read the keyframe and everything up to the tail, apply it, then the held
   records. A record at or before a district's newest tick is skipped, so a
   reconnect can read from the keyframe again.

The page draws one tick behind the newest one every district has, so a car
always has both ends of its motion. Its clock runs at the sim's speed and is
steered to keep that one tick of lag: a late record slows it, a burst speeds it
up, it never passes the newest tick and never runs backwards. The hour of day
is the tick's, never the wall clock's, so the sun, lamps and windows follow the
sim. A `trip` event gives a resident's route; the page rebuilds the trip from
its legs and the resident's schedule (`Resident::trip_from_route`), which
finds which of the resident's days it belongs to and where the first and last
leg start and end, and places the car by `position_at`. A trip that matches no
route is counted, not drawn. Trips already under way when a page opens are
not drawn until their resident's next trip.

## Seeking

To draw tick `T`:

1. For each district, find a record at or before `T`. Every tick has one record, so the client estimates the offset from the district's current tick and offset, reads one record, and corrects; with `offset_for_time` in the gateway this becomes one lookup by the record's append time.
2. That record's header names the district's latest keyframe offset. Read the keyframe.
3. Read from the keyframe to `T` with a bounded `read` and apply the events.
4. Draw. Cars in the middle of a trip are placed by interpolating their route at `T`.

In the browser, `web/src/seek.ts` does this on a connection of its own, so a seek never waits behind the live
subscriptions. One `Seeker` lives for the page: its session and caches carry from seek to seek, a newer seek cancels
an older one (its queued reads leave the gateway's queue), identical reads in flight are shared, and the districts are
read concurrently over two connections taken in turn (opened by the first seek, closed after 30 s idle and opened again by the next, so a page that is not seeking holds none of the gateway's eight sessions a person may have), the pages of a range together once the first has said how big a page is. A seek returns each district's records from its keyframe and the offset of the tick's record, which
is where a live subscription resumes, plus one.

The log is ordered by `(epoch, tick)`. A restarted sim takes the next epoch, so the newest epoch that reaches a tick is the
one shown, and a tick that landed twice is applied once. The estimate starts from the cached keyframe of `T`'s hour, or
else the newest keyframe the state key points at, and a log that is not one record a tick falls back to bisection between the
offsets known to be below and above `T`. A tick the log skipped shows the nearest earlier tick every district has, and the
result says it is not exact; a tick past the newest is refused as not yet happened. Retention that has taken the named
keyframe moves the start to the next hour boundary still kept, and a seek is `unretained` before it. Records are cached per
district for about two city hours and keyframes for four city days, so a second seek in the same hour reads only the
ticks past what is held. After folding, every district must be at `T`, or the seek fails. `?at=<tick>` opens the page at a
tick with no live connection (Back to live opens the page again without it), and `window.__metro.seek(tick)` does the same in an open page,
which is what CI measures against the one-second budget. The `window.__metro`, `__live` and `__seek` hooks exist only
with `?trace` in the URL or in a dev build, and every CI check opens the page with it.

At most 240 tick records per district separate a keyframe from `T`. That is a
few hundred KB at the target scale, read in parallel across districts.

**Playing forward** from `T` takes each district's records from the offset after the seek's
(`SeekResult.districts[d].offset + 1`) and applies them to the state folded to `T`, in order, once each. The
playhead moves at the city's own speed (the `speed` the records carry), never past the newest tick every
district has applied, and a record is applied only when the playhead is within two ticks of it. A district far from the
log's tail reads pages ahead of the playhead, at most 480 records queued; once its next record is within an hour of the live
tip it subscribes from its next offset, which Felix joins to live delivery with no gap, and the queue takes the frames
from there. A frame that skips an offset or arrives to a full queue is dropped, and the district reads from where it
was until it reaches the tail and then subscribes again. A read past the tail is "nothing yet" (felix-gateway#38), not
an error. The subscriptions are on a session of their own, in slots `p00`, `p01`, ..., that closes when the playback
ends. That session is opened as soon as the past is on screen and kept while it is, then closed 30 s after the page is
back on the live city, so Back to live finds it open (the page holds one live, up to two history and one playback session,
well within the gateway's eight a person).

Space and the pill's Play button play and pause from the past on screen. **Back to live** does not cut: the city's time
races forward with the cars moving, at the city's own pace plus a steady gain that closes the distance in about three
seconds (at most 960 ticks a second in all), paced by the wall clock. A timer moves the playhead and applies its records every 40 ms, off the render loop, so a catch-up takes about three seconds even where frames come once a second or slower; frames only draw the state (and also step the playhead by wall-clock time, so nothing is applied twice). When the playhead is within a tick of the live state's newest tick the
page hands over. Within a second of the tip it hands over at once. If the session is not open at the click, the race
starts anyway: the tick drawn, the sun and the bar's handle run on at the same pace, and the records follow when the
session opens; if it has not opened in 1.5 s the page shows the live city, with no note. Space and Play do nothing during the race, when no
control is shown. If the sim restarts mid-playback (a new epoch numbers its ticks from the start again) the playback
ends and the page shows the live city. The playback's session is closed when the page is left. The live state has taken every
record all along, so nothing is folded a second time and nothing reloads; the live clock is set to the playhead
first, so a car under way carries on from where it was drawn. Scrubbing while playing ends the playback; a page opened with `?at` has
no live state to join and cannot play.

**Scrubbing** draws the nearest keyframe on hand while the handle moves, with
the sun and the clock at the handle's hour, and fills in events once it rests.
One seek runs at a time, always for the newest target, and each result is drawn
as it completes, so scrubbing faster than a seek takes still shows the city
moving; a seek is never cancelled by the next move. A target ahead of the city
on screen in the same hour folds only the records after the last one it holds;
any move back refolds from the keyframe (and so replays a construction backwards). The newest record of each district is
trusted for a second between seeks. The bar spans the first hour that can be
started from to the live tip, with days as bands and a tick for every hour.
Arrow keys step 15 city minutes, `Shift` or the page keys an hour, `Home` goes to
the oldest moment and `End` back to live; a release or step within a city
minute of the tip, or Back to live while a seek is still running, ends in the
live city, and the result of that seek is dropped. A seek's result that would
bring the page to an hour whose keyframe is already on screen is dropped too.
The history sessions are opened when the bar is first hovered, focused or
touched, not at page load; the span is read again every 5 s only while the
handle is dragged or the past is shown, and the sessions close after 30 s idle. The pill in the clock reads how long
before the live tip the city on screen is, in city time.

## Building

Builders publish commands (`place road`, `zone`, `build`, `demolish`) to the
city's command stream, a gateway `stamp_sender` stream. The sim applies
commands at the next tick and records the result as a `command` event in the
district it touched, with a hash of the principal. Every change to the city
carries who made it, and that is visible on the timeline.

A `built` or `demolished` event is instantaneous in the log. The page spreads it over the next 8 ticks of city time
(`web/src/construction.ts`): a building rises from nothing inside a scaffold from the event's tick, and a demolished one
scales down under a puff of dust. What is drawn is a function of the event's tick and the tick on screen, with no
clock of its own, so a rewind plays it backwards and a seek into the middle of a window shows the right partial state.
`CityState` keeps the event's tick for every lot inside its window (`rising`, `falling`) and drops it after. A keyframe
lists only the finished lot, so a seek whose tick is within 8 ticks after its keyframe also reads the 7 records before
the keyframe, the cheapest way to find a start that came just before it; further on the cost is nothing. The live
join does not, since it has no earlier tick to compare with: a building that went up just before the keyframe a joining
page starts from is drawn finished.

Building is only allowed at the live tip. A builder who scrubs back sees the
past read-only, and building there means forking.

## Branching

A fork is a new city whose name records its parent and fork tick
(`harbor~bridge-closed`). The sim seeds it by copying each district's keyframe
at or before the fork tick into the fork's stream, replays the parent's events
up to the tick, and steps on from there, so the fork owes the parent nothing
after creation. The parent and fork can be shown side by side with their
timelines locked to the same tick.

## Rendering

- **Three.js**, plain TypeScript, no UI framework, built with Vite.
- **Kenney city kits** (Roads, Commercial, Suburban, Industrial, Car Kit): CC0, one consistent style, restyled by material name to one palette.
- **Instanced meshes** for cars, people, trees and repeated buildings.
- **Tilt-shift**: a depth-of-field pass weighted to the top and bottom of the frame, with saturated colour, so the city reads as a model.
- **Day and night from the tick.** Sun angle, sky, street lights and window lights all follow the city clock, live and while scrubbing.
- **Quality tiers** so the look degrades before the frame rate does. The target is 60 fps at 20,000 residents on a laptop iGPU.

How it looks gets its own note, `docs/art.md`, and a style frame, in M0.

## Build order

| M   | Milestone                                                                                       | Proves                                               |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0   | The look, locked: style frame, asset pipeline, tilt-shift, day/night, instancing, quality tiers | It looks good at 60 fps before anything is simulated |
| 1   | A live city: `core`, the sim committing district ticks, the dev stack, the browser drawing live | Trips flow through Felix and look right              |
| 2   | Time travel: keyframes, seeking, the timeline, rewind then follow                               | Demonstrations 1 and 2, the headline                 |
| 3   | Follow a life: pick a resident or car, see their day; markers for notable events                | Per-entity history from the same log                 |
| 4   | Build: commands, placement tools, attribution                                                   | One authority applies everyone's edits               |
| 5   | Branching timelines: fork, side by side                                                         | Demonstration 5                                      |
| 6   | Scale and failover: 20,000 residents, 16 districts, sim restart, broker loss                    | Demonstrations 3 and 4                               |
| 7   | Self-hosting: images, compose, Helm, releases                                                   | Anyone can run it                                    |

**M0 comes first on purpose**, for the reason felix-arena gives: looking very
good is the requirement most likely to fail late, so the look is fixed before
anything is built inside it.

## Risks, and what this surfaces in Felix

- **Interpolation drift.** A car drawn by interpolation can disagree with where the sim thinks it is if the sim changes its plan without a `replan`. Every change of plan is an event, and the client trusts the log over its own guess.
- **Retention.** History is bounded by one broker's disk. At 1 GB a day that is weeks, but tiered storage that Felix can read back would make it unbounded.
- **Scope.** No feature that does not serve one of the five demonstrations or the look.

**Felix gaps this design runs into**

1. **No time lookup in the gateway.** `offset_for_time` exists in Felix but felix-gateway does not expose it, so seeking estimates and corrects. Adding it upstream makes a seek one lookup per district.
2. **Per-shard subscribe through the gateway.** The gateway's `read` takes a shard. Subscribing to one district's shard from a browser needs checking, and adding if missing.
3. **Tiered storage has no read path.** Offloaded segments cannot be read back, so history older than local retention is gone.
4. **A commit is not idempotent.** A retried tick can land twice; readers dedupe on `(epoch, district, tick)`.

**Open questions**

- [ ] One keyframe per city hour, or adaptive (more often when a lot changed)?
- [ ] Should forks be visible to everyone, or private to the person who made them?
