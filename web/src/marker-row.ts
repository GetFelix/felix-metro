// The row of notable moments above the timeline: one button for each marker, or for each cluster of them where the bar
// is too short to keep them apart. It sits beside the bar and not inside it, since the bar is a slider and a slider's
// children are hidden from a screen reader.
import { clusterMarkers, clusterName, clusterTarget, type Cluster, type Marker } from './markers';

/** Markers nearer than this many pixels share a button. */
const GAP_PX = 14;
/** Before the row has been measured. */
const GUESS_WIDTH = 640;

export interface MarkerRowView {
  /** The bar's scale, as the timeline draws it. */
  oldest: number;
  newest: number;
  /** The markers inside the bar, in order. */
  markers: readonly Marker[];
  /** Where the handle is, which a click on a cluster steps on from. */
  at: number;
}

/** Whether two clusterings put the same markers on the same buttons. */
const sameClusters = (a: readonly Cluster[], b: readonly Cluster[]): boolean =>
  a.length === b.length &&
  a.every(
    (c, i) =>
      c.markers.length === b[i]!.markers.length &&
      c.markers.every((m, j) => m.tick === b[i]!.markers[j]!.tick && m.label === b[i]!.markers[j]!.label),
  );

/** Build the row inside `root`, a toolbar. `onSeek` is told the tick of the marker that was chosen. */
export function createMarkerRow(root: HTMLElement, onSeek: (tick: number) => void) {
  root.replaceChildren();
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Notable moments');
  let width = 0;
  let measured = false;
  let at = 0;
  let clusters: Cluster[] = [];
  let buttons: HTMLButtonElement[] = [];
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => (measured = false)).observe(root);

  const focusAt = (i: number) => {
    const to = buttons[Math.max(0, Math.min(buttons.length - 1, i))];
    if (!to) return;
    for (const b of buttons) b.tabIndex = b === to ? 0 : -1;
    to.focus();
  };
  root.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') focusAt(i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') focusAt(i - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(buttons.length - 1);
    else return;
    e.preventDefault();
  });
  root.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button.moment');
    const cluster = button && clusters[buttons.indexOf(button)];
    if (cluster) onSeek(clusterTarget(cluster, at));
  });

  return {
    /**
     * Draw the row for `view`. Cheap to call every frame: the buttons slide by their CSS variables, and are replaced
     * only when the markers or the way they group change, so hover and focus survive the live tip moving.
     */
    update(view: MarkerRowView) {
      at = view.at;
      if (!measured) {
        width = root.clientWidth || GUESS_WIDTH;
        measured = true;
      }
      const span = view.newest - view.oldest;
      root.style.setProperty('--oldest', String(view.oldest));
      root.style.setProperty('--span', String(span));
      const next = clusterMarkers(view.markers, (GAP_PX * span) / width);
      if (sameClusters(clusters, next)) return;
      const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const keep = focused >= 0 ? clusters[focused]?.tick : undefined;
      clusters = next;
      buttons = clusters.map((c) => {
        const first = c.markers[0]!;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'moment';
        b.dataset.kind = c.markers.every((m) => m.kind === first.kind) ? first.kind : 'mixed';
        b.dataset.tick = String(c.tick);
        if (c.markers.length > 1) b.dataset.count = String(c.markers.length);
        b.style.setProperty('--t', String(c.tick));
        b.setAttribute('aria-label', clusterName(c));
        b.title = clusterName(c);
        b.tabIndex = -1;
        return b;
      });
      root.replaceChildren(...buttons);
      const kept = keep === undefined ? -1 : clusters.findIndex((c) => c.tick === keep);
      const reach = buttons[kept >= 0 ? kept : 0];
      if (reach) reach.tabIndex = 0;
      if (kept >= 0) reach?.focus({ preventScroll: true });
    },
  };
}
