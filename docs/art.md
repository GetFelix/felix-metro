# Art direction

Felix Metro is a model city on a table: low-poly, saturated, seen from above
through a tilt-shift lens, with the time of day doing most of the mood. The
reference is [prototype/style-frame.html](../prototype/style-frame.html).

| Noon | Golden hour | Night |
|---|---|---|
| ![Noon](screenshots/style-frame-day.jpg?v=2) | ![Golden hour](screenshots/style-frame-golden-hour.jpg?v=2) | ![Night](screenshots/style-frame-night.jpg?v=2) |

## Assets

Six Kenney packs, all CC0 and one family. They share Kenney's gradient-swatch
palette and proportions, so they sit together without restyling by hand.

| Pack | Used for | Notes |
|---|---|---|
| City Kit (Roads) | Roads, crossings, pavement lots, street lights, traffic lights | Tiles are 1 × 1 units; the grid is built on them. `road-straight` runs along X |
| City Kit (Commercial) | Downtown and commercial lots, towers | 14 buildings, 5 towers, awnings and parasols |
| City Kit (Suburban) | Houses, trees, fences, driveways | Also the source of every tree |
| City Kit (Industrial) | Factories, tanks, chimneys, containers, water tower | |
| Car Kit | Traffic | Sedan, taxi, SUV, van, delivery, police, ambulance, trucks; scaled to 0.12 |
| Mini Characters | Pedestrians | Rigged, with `walk`, `idle`, `sit` and more; scaled to 0.22 |

Considered and left out:

- **Nature Kit**: an older, flat-coloured style that does not match the city kits. Trees come from the suburban pack.
- **Anything not Kenney**: mixing families is how low-poly scenes end up looking like asset flips.

Gaps for later milestones: no buses or trams, no parks furniture beyond parasols.
Construction has no models of its own; see [Construction](#construction).

## Asset pipeline

`web/src/assets.ts` globs every GLB under `prototype/assets/models`, so a model is addressed by pack (folder) and file name and a new file needs no code. `models.ts` loads each file once and clones it per placement. `materials.ts` builds the colormap variants and the window mask once per pack and shares materials by pack, variant and light level. `web/models.html` loads every model and runs in CI.

## Rules

- **Colour comes from recoloured colormaps.** Every model of a pack samples one 512 × 512 `colormap.png`. The default has white walls and green roofs; a building's look is a variant of that texture with its wall swatches (bright, unsaturated) and roof swatches (green) tinted from the palette lists in the style frame. Windows, trims and roads keep Kenney's colours.
- **Lit windows come from the same texture.** The colormap's light-blue swatches are windows; a mask of them is the emissive map, scaled by how dark it is. Towers use a lower level because their glass is one large swatch.
- **Light pools are decals.** Street lights and headlights are additive sprites and ground decals, not real lights, so hundreds cost almost nothing. They are hidden from the ambient occlusion pass.
- **Time of day is one function.** Sky, fog, sun, hemisphere light, exposure, window light, lamps and headlights all come from the hour (`web/src/daylight.ts`). Each building starts lighting its windows at its own fixed time between 17:30 and 19:30 and starts to darken between 06:00 and 07:30, each fade taking ten minutes, so the last are done by 19:40 and 07:40. Each street lamp switches on at its own time between 18:27 and 18:47 and fades out at dawn between 06:54 and 07:14, nine minutes either way. Both come from a hash of position, so the same moment always looks the same. The sun sets in the west (+x), on the camera's side, so evening light falls on the faces in view.
- **Post processing**, in order: ambient occlusion (high tier only, see [Quality tiers](#quality-tiers)), bloom with a threshold of 1 so only lights glow, tilt-shift blur, tone mapping, then a small saturation lift and vignette. The blur is by depth, like a miniature photo: it grows with distance from the focus plane through the orbit target, so a tall building at that depth stays sharp to its roof.
- **Buildings fit their lot.** Some Kenney buildings are wider than a tile, so each is scaled down to fit 0.9 of its lot and none overlap.
- **Brand**: Inter and JetBrains Mono, cyan `hsl(192, 90%, 46%)` for Felix accents, amber for light, and coral to violet for the timeline. The Felix tower downtown carries the mark.

## Using the style frame

Serve the repository root (`python3 -m http.server`) and open
`/prototype/style-frame.html`. Parameters:

| Parameter | Effect |
|---|---|
| `?t=17.8` | Freeze the clock at that hour |
| `?still` | Freeze cars and people, for screenshots |
| `?tier=low\|medium\|high` | Force a quality tier and turn off the automatic choice |
| `?hud` | Frame-time overlay under the brand chip |
| `?ui=0` | Hide the overlay |

The app (`web/`) draws the city generated from the seed in the URL hash (`/#harbor`), 2 × 2 districts by default (`?districts=3`). `?layout=frame` draws the style frame's hand-made map instead, which is what CI compares against the frame. `?live=0` skips the gateway and draws the city with no traffic, and `?gateway=ws://host:8787/ws` names a gateway other than the page's own.

The screenshots above are `?t=12&still`, `?t=17.8&still` and `?t=21&still` at
1600 × 900.

## Construction

A building takes 8 ticks (two seconds at the default speed) to go up or come down, from the tick of its `built` or
`demolished` event. Both are drawn from the tick on screen alone, so scrubbing plays them backwards.

- **Rising:** the building grows from the ground to its height and a scaffold climbs round it: a square frame of four
  posts and four rails in warm timber (`0xd9a05b`), 0.94 tiles wide, standing a little taller than the wall and settling
  to its height as the building tops out. Nothing is left once the 8 ticks are up.
- **Coming down:** the building shrinks to the ground (from the height it had, when a rise was cut short), fully opaque,
  with the same scaffold round it, while twelve grey-tan dust sprites (`0xb8b0a4`, 0.6 to 1 tile) ring the lot. The
  cloud swells to full strength at the middle of the window and thins out again, so it reads against the pale ground.
- **Cost:** the frames, dust and stand-in buildings are pools made once (24 scaffolds, 8 puffs, 24 stand-ins), nothing is
  allocated per frame, and a lot that finds a pool full goes without that effect for its whole window, so nothing pops in
  late. The low tier leaves out the scaffold and the dust and only scales the building.
- **Which tick ends it:** an animation is dropped once the tick on screen, not the newest record, is past its window, so
  records applied ahead of the picture (a gap filled, a playback timer) do not cut a building short. A live keyframe
  leaves the animations a state already follows; only a fresh fold starts with none.

`web/construction.html` draws one lot at a tick from the URL (`?mode=build|demolish&tick=104&via=forward|seek|back&tier=low`)
and `web/scripts/check-construction.mjs` compares it with `web/references/construction-rise.png` and
`construction-fall.png` in CI, and with the same lot a quarter of the way in (`-early`, tick 102) so the length of the window is pinned as well as its middle. A window of 9 ticks instead of 8 differs from the four references by 6.4%, 4.2%, 1.3% and 0.9%; the check allows 1%. They are renders of the page on software GL, so rewrite them with
`UPDATE_REFERENCES=1 node scripts/check-construction.mjs <url> <out>` after a change to the look.

## Quality tiers

Each tier drops effects in the order that costs the least in looks, so the
picture degrades before the frame rate does.

| Tier | Ambient occlusion | Tilt-shift | Shadows | Pixel ratio | Pedestrian rigs\* |
|---|---|---|---|---|---|
| high | yes | yes | 4096 map | up to 2 | yes |
| medium | no | yes | 2048 map | up to 2 | no |
| low | no | no | no | 1 | no |

\* The `rigs` flag is set only on high. Rigged pedestrians arrive with #6; until then nothing reads it.

`web/src/quality.ts` chooses the tier. It starts on high and measures frame
times for the first 3 seconds after the city is ready, ignoring the first 5
frames and any time the tab is hidden. It steps down one tier when the median
is over 22 ms, or over 1.3 times the display's frame interval if that is
longer. The interval is estimated from the fastest tenth of frames and held
between 4 and 33.4 ms, so a steady 30 Hz display is not treated as slow.
After a step it rebuilds the post chain and judges another 1.5 seconds,
repeating until a window passes or it reaches low. It never steps up. A frozen
scene (`?still`) has no meaningful frame times, so it never chooses on its own
and ignores a saved tier.

A tier from `?tier=` or from a saved choice is used as it is and turns the
automatic choice off. The settings sheet, coming with the UI shell, saves a
choice through `setTier()`. Automatic choices are not saved: a slow first load
should not pin a device to low for good.

`?hud` shows the median and 95th percentile frame time over the last 120
frames, draw calls and triangles for the last frame, and the tier with whether
it was chosen automatically, forced, or fixed because the scene is frozen.
`?slow=40` adds 40 ms to every frame so CI can exercise the step-down.
