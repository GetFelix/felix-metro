- Point at a building (tap it on a phone) and a card says who built it and when: "Built by Ana · Day 2, 09:12 · See
  it go up". Your own read "Built by you", and buildings the city began with read "Here since the start". "See it go
  up" takes the city to 30 city seconds before the building was built through the timeline's own seek, and plays it
  forward. The page asks the gateway for the `principal` feature to know which buildings are yours; a gateway without
  it (before 0.8.0) shows names only. The card is left out with `?ui=0`.
- A tap is timed from when the browser made the touch events, so a busy page that handles them late still opens the card.
- On a phone the card stays after the tap that opened it; the finger leaving the canvas used to hide it a third of a second later.
