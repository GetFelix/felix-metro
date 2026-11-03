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
