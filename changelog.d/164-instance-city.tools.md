- The traffic check bounds the draw calls of the whole frame (`TRAFFIC_MAX_CALLS`) and of the 16 district measuring page
  (`TRAFFIC_MAX_RUN_CALLS`), so the static city cannot go back to a draw call for each object. `web/traffic-load.html`
  gives scripts the renderer and scene as `window.__three`.
