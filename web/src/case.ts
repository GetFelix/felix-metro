// A case file: a city nobody can command, with one question about the day in it. The player works out the busiest
// street, hour and purpose by watching, then answers all three at once and is told only whether they are all right.
// The table is in core/src/investigation.rs, where the sim's tests recompute it from the day's events.

/** The purposes an answer can name: the activity the drivers set off to do. */
export const PURPOSES = [
  { value: 'home', label: 'Going home' },
  { value: 'work', label: 'Work' },
  { value: 'school', label: 'School' },
  { value: 'shop', label: 'Shopping' },
  { value: 'leisure', label: 'Leisure' },
] as const;

/** A case file as core describes it. */
export interface Investigation {
  seed: string;
  /** The city day the question is about, counted from 0. */
  day: number;
  /** The hour of the day, 0 to 23, in which the most trips by vehicle set off. */
  hour: number;
  street: string;
  purpose: string;
  /** The first of the two hours the hint names. */
  hintFrom: number;
  /** A street that crosses the answer. */
  neighbour: string;
}

/** What the player has chosen. A part they have not chosen yet is `null`. */
export interface Answer {
  street: string | null;
  hour: number | null;
  purpose: string | null;
}

export interface CaseState {
  /** Complete answers checked so far. */
  attempts: number;
  solved: boolean;
}

export const OPEN_CASE: CaseState = { attempts: 0, solved: false };

/** The case file core sent as JSON, or `null` if the city has none. */
export function readInvestigation(json: string | undefined): Investigation | null {
  if (json === undefined) return null;
  const raw = JSON.parse(json) as Partial<Investigation>;
  const { seed, day, hour, street, purpose, hintFrom, neighbour } = raw;
  if (
    typeof seed !== 'string' ||
    typeof day !== 'number' ||
    typeof hour !== 'number' ||
    typeof street !== 'string' ||
    typeof purpose !== 'string' ||
    typeof hintFrom !== 'number' ||
    typeof neighbour !== 'string'
  ) {
    return null;
  }
  return { seed, day, hour, street, purpose, hintFrom, neighbour };
}

/** Whether all three parts are right. Nothing says which part is wrong. */
export function isRight(inv: Investigation, answer: Answer): boolean {
  return answer.street === inv.street && answer.hour === inv.hour && answer.purpose === inv.purpose;
}

/** Whether every part has been chosen, so the answer can be checked. */
export function isComplete(answer: Answer): boolean {
  return answer.street !== null && answer.hour !== null && answer.purpose !== null;
}

/**
 * Checks an answer. An incomplete one is not an attempt, and neither is any answer once the case is solved, so the count
 * stays what it took to solve it.
 */
export function attempt(inv: Investigation, state: CaseState, answer: Answer): CaseState {
  if (state.solved || !isComplete(answer)) return state;
  return { attempts: state.attempts + 1, solved: isRight(inv, answer) };
}

const clock = (hour: number) => {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;
};

/** The hour that starts at `hour`, the way the answer lists it: "7 am to 8 am". */
export function hourLabel(hour: number): string {
  return `${clock(hour)} to ${clock(hour + 1)}`;
}

/** The question, in the day's terms on the page's clock (which counts days from 1). */
export function question(inv: Investigation): string {
  return (
    `Day ${inv.day + 1} had a jam. In the hour when the most people set off in a vehicle, ` +
    'which street did the most of them use, and what were they driving to do?'
  );
}

/** What the hints say: a two-hour window and a street that crosses the answer, never the answer itself. */
export function hints(inv: Investigation): string[] {
  return [
    `It was between ${clock(inv.hintFrom)} and ${clock(inv.hintFrom + 2)}.`,
    `${inv.neighbour} crosses the street.`,
  ];
}

/** The line beside the heading. */
export function statusText(state: CaseState): string {
  if (state.solved) return state.attempts === 1 ? 'Solved first try' : `Solved in ${state.attempts} tries`;
  return state.attempts === 0 ? 'Open' : `Open, ${state.attempts} ${state.attempts === 1 ? 'try' : 'tries'}`;
}

/** What to tell the player after they press Check. */
export function verdictText(state: CaseState, answer: Answer): string {
  if (state.solved) return 'Case closed. All three are right.';
  if (!isComplete(answer)) return 'Choose a street, an hour and a purpose.';
  return 'Not all three are right. Watch the day again.';
}
