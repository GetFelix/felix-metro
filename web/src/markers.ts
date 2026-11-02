// The notable moments the timeline marks. Two sources: rush hours come from the clock alone, and what builders did
// is the sim's per-day list, kept in the events stream's state (docs/design.md, "Timeline markers"). The maths here is
// plain functions; the timeline draws what they return.
import { decodeRecord } from './core/felix_metro_core.js';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import { momentText } from './timeline';
import { ROAD_ADDED, ROAD_CLOSED, ROAD_OPENED } from './city';

export type MarkerKind = 'rush' | 'built' | 'demolished' | 'road';

export interface Marker {
  tick: number;
  kind: MarkerKind;
  /** What a screen reader and the tooltip say, without the time. */
  label: string;
}

interface Span {
  oldest: number;
  /** The newest tick every district has: nothing later has happened. */
  live: number;
}

/** The morning and evening peaks: office workers arrive about 08:00 and leave about 17:15 (docs/design.md, "Residents"). */
const RUSH = [
  { hour: 8, label: 'Morning rush hour' },
  { hour: 17.25, label: 'Evening rush hour' },
] as const;

/** The rush hour peaks inside the span, which need nothing but the clock. */
export function rushMarkers(span: Span): Marker[] {
  const out: Marker[] = [];
  for (let day = Math.floor(span.oldest / TICKS_PER_DAY); day * TICKS_PER_DAY <= span.live; day++) {
    for (const { hour, label } of RUSH) {
      const tick = day * TICKS_PER_DAY + hour * TICKS_PER_HOUR;
      if (tick >= span.oldest && tick <= span.live) out.push({ tick, kind: 'rush', label });
    }
  }
  return out;
}

/** The state key the sim keeps a city day's markers in; `day` counts from 0. */
export const markersKey = (day: number): string => `markers.${day}`;

const ROAD_WORDS: Record<number, string> = {
  [ROAD_CLOSED]: 'closed',
  [ROAD_OPENED]: 'opened',
  [ROAD_ADDED]: 'added',
};

/** The sim's `type` codes of a marker (`MARK_*` in core/src/record.rs). */
function describe(type: number, what: number, by: string): { kind: MarkerKind; label: string } | null {
  const who = by === '' ? null : by;
  switch (type) {
    case 1:
      return { kind: 'built', label: who ? `${who} built a building` : 'A building went up' };
    case 2:
      return { kind: 'demolished', label: who ? `${who} tore a building down` : 'A building came down' };
    case 3: {
      const word = ROAD_WORDS[what] ?? 'removed';
      return { kind: 'road', label: who ? `${who} ${word} a road` : `A road was ${word}` };
    }
    default:
      return null;
  }
}

/** The markers in one day's stored list, or null for bytes that are not one. */
export function parseMarkers(bytes: Uint8Array): { day: number; markers: Marker[] } | null {
  try {
    const record = JSON.parse(decodeRecord(bytes));
    if (record.kind !== 'markers' || !Array.isArray(record.markers)) return null;
    const markers: Marker[] = [];
    for (const m of record.markers) {
      const found = describe(Number(m.type), Number(m.what), String(m.by ?? ''));
      if (found) markers.push({ tick: Number(m.tick), ...found });
    }
    return { day: Number(record.day), markers };
  } catch (err) {
    console.error('a markers record did not decode', err);
    return null;
  }
}

/** Markers in order, the clock-derived and the stored ones together, none past the live tip or before the oldest. */
export function mergeMarkers(span: Span, stored: readonly Marker[]): Marker[] {
  return [...rushMarkers(span), ...stored.filter((m) => m.tick >= span.oldest && m.tick <= span.live)].sort(
    (a, b) => a.tick - b.tick || (a.kind === 'rush' ? -1 : 1),
  );
}

export interface MarkerFeed {
  /** Read the days `span` touches that are not settled, and report whether the list changed. Never throws. */
  load(span: Span, now?: number): Promise<boolean>;
  /** The stored markers of every day held, oldest first. */
  readonly stored: Marker[];
}

/**
 * The stored markers by day. A day before the tip's is over and its list is read once; the tip's day is read every
 * time, since it still grows. A read that fails leaves the day as it was, unsettled, and is tried again by a later load
 * once a wait that doubles from a second to half a minute has passed.
 */
export function createMarkerFeed(read: (day: number) => Promise<Uint8Array | null>): MarkerFeed {
  const days = new Map<number, { markers: Marker[]; settled: boolean }>();
  const failed = new Map<number, { count: number; retryAt: number }>();
  return {
    async load(span, now = Date.now()) {
      const first = Math.floor(span.oldest / TICKS_PER_DAY);
      const last = Math.floor(span.live / TICKS_PER_DAY);
      let changed = false;
      for (const day of days.keys()) {
        if (day < first) {
          days.delete(day);
          changed = true;
        }
      }
      const wanted: number[] = [];
      for (let day = first; day <= last; day++) {
        if (!days.get(day)?.settled && (failed.get(day)?.retryAt ?? 0) <= now) wanted.push(day);
      }
      await Promise.all(
        wanted.map(async (day) => {
          let bytes: Uint8Array | null;
          try {
            bytes = await read(day);
          } catch {
            const count = (failed.get(day)?.count ?? 0) + 1;
            failed.set(day, { count, retryAt: now + Math.min(30_000, 1000 * 2 ** (count - 1)) });
            return;
          }
          failed.delete(day);
          const parsed = bytes && parseMarkers(bytes);
          const markers = parsed && parsed.day === day ? parsed.markers : [];
          const before = days.get(day)?.markers;
          days.set(day, { markers, settled: day < last });
          if (!before || before.length !== markers.length || before.some((m, i) => m.tick !== markers[i]!.tick)) {
            changed = true;
          }
        }),
      );
      return changed;
    },
    get stored() {
      return [...days.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, d]) => d.markers);
    },
  };
}

export interface Cluster {
  /** The tick of the first marker; where the cluster sits on the bar. */
  tick: number;
  markers: Marker[];
}

/**
 * Markers closer than `gap` ticks to the one before them share a cluster, so a busy hour is one button and not a
 * smear. The gap is measured from the cluster's first marker, so a long run still splits.
 */
export function clusterMarkers(markers: readonly Marker[], gap: number): Cluster[] {
  const out: Cluster[] = [];
  for (const m of markers) {
    const last = out[out.length - 1];
    if (last && m.tick - last.tick < gap) last.markers.push(m);
    else out.push({ tick: m.tick, markers: [m] });
  }
  return out;
}

/**
 * The cluster that holds the moment `tick`, for keeping focus on it when clusters regroup: the last one that starts at
 * or before it, or -1 when it comes before them all.
 */
export function clusterAt(clusters: readonly Cluster[], tick: number): number {
  let found = -1;
  for (const [i, c] of clusters.entries()) if (c.tick <= tick) found = i;
  return found;
}

/**
 * Where a click on a cluster goes: the first of its markers after the handle, or the first when it is at or past
 * them all, so clicking again walks through a cluster.
 */
export function clusterTarget(cluster: Cluster, at: number): number {
  return (cluster.markers.find((m) => m.tick > at) ?? cluster.markers[0]!).tick;
}

/** What a marker button is called: `Mara built a building, Day 2, 14:15`. */
export const markerName = (m: Marker): string => `${m.label}, ${momentText(m.tick)}`;

/** What a cluster button is called: the marker's name for one, a count and the first time for several. */
export function clusterName(c: Cluster): string {
  const [first] = c.markers;
  if (c.markers.length === 1 && first) return markerName(first);
  const labels = [...new Set(c.markers.map((m) => m.label))];
  const shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ', and more' : '');
  return `${c.markers.length} moments from ${momentText(c.tick)}: ${shown}`;
}
