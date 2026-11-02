// Runs in the page, so it must not use anything outside itself: Playwright sends its source to the browser.
/**
 * True once the frame record holds the frame the page joined live in and `after` frames past it. The join is set by a
 * timer between frames, so on a slow renderer the first frame to show it can come seconds after the page is live.
 */
export const joinRecorded = (after) => {
  const frames = window.__frames;
  const j = frames.findIndex((f, i) => f.joined && i > 0 && !frames[i - 1].joined);
  return j >= 0 && frames.length - j > after;
};
