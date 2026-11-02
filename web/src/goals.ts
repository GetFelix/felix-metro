// A chapter's goals, judged from what the page already reads: the council event and the funds. The numbers come from
// the chapter table in core, which the sim also plays, so the page and the sim agree on what counts as won.
import type { CouncilEvent } from './council';
import { money } from './money';
import { USUAL_POLICY, type PolicyEvent } from './policy';

/** A chapter as core describes it. */
export interface Chapter {
  seed: string;
  /** The speed limits the city opens with, in percent of the roads' speed. */
  openingAvenueLimit: number;
  openingStreetLimit: number;
  /** City days the mayor has: the goals are judged once this many have been scored. */
  days: number;
  /** The longest average trip to work or school that meets the commute goal, in ticks. */
  commuteTicks: number;
}

export type GoalState = 'met' | 'open' | 'failed';

export interface GoalRow {
  text: string;
  state: GoalState;
  /** How the city stands on it now, or `null` before the first day is scored. */
  now: string | null;
}

export interface GoalsView {
  /** `playing` until the last day is scored, then `won` or `lost`; a recall or an empty account loses at once. */
  verdict: 'playing' | 'won' | 'lost';
  /** The line beside the heading: the day, or how the chapter ended. */
  status: string;
  rows: GoalRow[];
}

/** A tick is 15 city seconds, so four to a minute. */
const TICKS_PER_MINUTE = 4;

const minutes = (ticks: number) => {
  const m = ticks / TICKS_PER_MINUTE;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};

/** The chapter core sent as JSON, or `null` if the city has none. */
export function readChapter(json: string | undefined): Chapter | null {
  if (json === undefined) return null;
  const raw = JSON.parse(json) as Partial<Chapter>;
  const { seed, openingAvenueLimit, openingStreetLimit, days, commuteTicks } = raw;
  if (
    typeof seed !== 'string' ||
    typeof openingAvenueLimit !== 'number' ||
    typeof openingStreetLimit !== 'number' ||
    typeof days !== 'number' ||
    typeof commuteTicks !== 'number'
  ) {
    return null;
  }
  return { seed, openingAvenueLimit, openingStreetLimit, days, commuteTicks };
}

/** The policies a chapter city has until the mayor changes one: the sim writes no `policy` event before that. */
export function openingPolicy(chapter: Chapter | null): PolicyEvent {
  if (chapter === null) return USUAL_POLICY;
  const [shops] = USUAL_POLICY.settings;
  return {
    type: 'policy',
    settings: [
      shops!,
      { value: chapter.openingAvenueLimit, changed: null },
      { value: chapter.openingStreetLimit, changed: null },
    ],
  };
}

/** Where the chapter stands, given the council and funds at the tick on screen (`null` before either is known). */
export function goalsView(chapter: Chapter, council: CouncilEvent | null, funds: number | null): GoalsView {
  const scored = council !== null && council.days > 0;
  const last = scored && council.days >= chapter.days;
  const commute = council?.standings[0];
  const recalled = council?.standings.some((s) => s.unhappyDays >= council.patience) ?? false;

  const commuteMet = scored && commute !== undefined && commute.measure <= chapter.commuteTicks;
  const rows: GoalRow[] = [
    {
      text: `Trips to work or school average ${minutes(chapter.commuteTicks)} or less`,
      state: commuteMet ? 'met' : last ? 'failed' : 'open',
      now: scored && commute ? minutes(commute.measure) : null,
    },
    {
      text: 'No faction recalls the mayor',
      state: recalled ? 'failed' : 'met',
      now: null,
    },
    {
      text: 'The account stays above $0',
      state: funds === null ? 'open' : funds > 0 ? 'met' : 'failed',
      now: funds === null ? null : money(funds),
    },
  ];
  const lost = rows.some((r) => r.state === 'failed');
  const won = last && rows.every((r) => r.state === 'met');
  const verdict = lost ? 'lost' : won ? 'won' : 'playing';
  const day = Math.min((council?.days ?? 0) + 1, chapter.days);
  const status = verdict === 'won' ? 'Won' : verdict === 'lost' ? 'Lost' : `Day ${day} of ${chapter.days}`;
  return { verdict, status, rows };
}
