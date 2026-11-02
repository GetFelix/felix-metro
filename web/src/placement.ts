// The building tools without a screen: which tool is held, what it would do on the lot under the pointer, and what
// became of the commands it sent. The page draws it (placement-view.ts, ui/build-bar.ts) and feeds it the pointer.
import {
  FIRST_KIND,
  RESULT_APPLIED,
  buildCommand,
  canBuild,
  canDemolish,
  demolishCommand,
  newId,
  nextKind,
  refusal,
  type Check,
  type Ground,
} from './build';
import { GatewayError } from './gateway';

export type Tool = 'build' | 'demolish';

/** What stops commands going out now, from the live connection: signed in without the right, or out of reach. */
export type Blocked = 'viewer' | 'down';

/** The way commands leave the page. */
export interface CommandLink {
  /** The display name commands carry, from the sign-in. */
  readonly name: string;
  blocked(): Blocked | null;
  send(record: Uint8Array): Promise<void>;
}

export interface PlacementDeps {
  ground(): Ground;
  /** The live connection, or null when the page has none. */
  link: CommandLink | null;
  /** Whether the live city is what is on screen: not an earlier moment, and not on its way to one. */
  atTip(): boolean;
  /** Whether the page asked for a live city at all (`?live=0` and a page opened at a moment do not). */
  wantsLive: boolean;
  /** Where a lot faces, as a quarter turn, when the builder has not turned the building. */
  facing(lot: number): number;
  newId?: () => number;
}

/** The ghost on a lot: what the tool would do there, and whether it can. */
export interface Preview {
  lot: number;
  tool: Tool;
  kind: number;
  rotation: number;
  check: Check;
}

/** What the panel says about the last thing sent. */
export type Status =
  | { state: 'idle' }
  | { state: 'sending' | 'waiting'; text: string }
  | { state: 'done' | 'refused'; text: string };

/** How long a command may go unanswered before the page says so. The command may still go through. */
export const ANSWER_MS = 20_000;

const SENDING = 'Sending…';
const WAITING = 'Waiting for the city…';

/** Why the tools are not usable now, in plain words, or null when they are. */
export function whyNot(deps: Pick<PlacementDeps, 'link' | 'atTip' | 'wantsLive'>): string | null {
  if (!deps.wantsLive || !deps.link) return 'Building needs a live city.';
  if (!deps.atTip()) return 'Go back to live to build.';
  const blocked = deps.link.blocked();
  if (blocked === 'viewer') return 'Your sign-in cannot build in this city.';
  if (blocked === 'down') return 'The city is out of reach. Try again in a moment.';
  return null;
}

interface Waiting {
  tool: Tool;
  lot: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Placement {
  tool: Tool | null = null;
  kind = FIRST_KIND;
  /** A quarter turn the builder chose, or null to face the street. */
  private turn: number | null = null;
  status: Status = { state: 'idle' };
  /** How many commands have been answered: by the city, by the page turning one away, by a failed send or by running out of patience. */
  answered = 0;
  /** How many commands have gone out. */
  sent = 0;
  private readonly waiting = new Map<number, Waiting>();
  private hovered: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(private readonly deps: PlacementDeps) {}

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Why the tools cannot be used now, or null. */
  unavailable(): string | null {
    return whyNot(this.deps);
  }

  /** Pick a tool, or put it away with `null` or by picking the one already held. False, and no change, when blocked. */
  select(tool: Tool | null): boolean {
    if (tool !== null && this.unavailable()) return false;
    this.tool = tool === this.tool ? null : tool;
    this.hovered = null;
    this.changed();
    return true;
  }

  /** The tools were in use and cannot be now: put the tool away. */
  drop(): void {
    if (this.tool === null) return;
    this.tool = null;
    this.hovered = null;
    this.changed();
  }

  setKind(kind: number): void {
    this.kind = kind;
    this.changed();
  }

  step(by: number): void {
    this.setKind(nextKind(this.kind, by));
  }

  /** Turn the building a quarter turn clockwise from the way it faces now. */
  rotate(lot: number | null = this.hovered): void {
    const now = this.turn ?? (lot === null ? 0 : this.deps.facing(lot));
    this.turn = (now + 1) % 4;
    this.changed();
  }

  /** The turn the builder chose, if any. */
  get chosenTurn(): number | null {
    return this.turn;
  }

  hover(lot: number | null): void {
    if (lot === this.hovered) return;
    this.hovered = lot;
    this.changed();
  }

  get hoveredLot(): number | null {
    return this.hovered;
  }

  /** What the tool would do on `lot`, or null with no tool held. */
  preview(lot: number | null = this.hovered): Preview | null {
    if (this.tool === null || lot === null) return null;
    const ground = this.deps.ground();
    const rotation = this.turn ?? this.deps.facing(lot);
    const mine = [...this.waiting.values()].some((w) => w.lot === lot);
    const check: Check = mine
      ? { ok: false, why: 'Your last change here is still going through.' }
      : this.tool === 'build'
        ? canBuild(ground, lot)
        : canDemolish(ground, lot);
    return { lot, tool: this.tool, kind: this.kind, rotation, check };
  }

  /** Use the tool on `lot`. Returns the reason it was not sent, or null when a command went out. */
  async commit(lot: number): Promise<string | null> {
    const why = this.unavailable();
    if (why) return why;
    const preview = this.preview(lot);
    if (!preview) return 'Pick a tool first.';
    if (!preview.check.ok) {
      this.answered++;
      this.status = { state: 'refused', text: preview.check.why };
      this.changed();
      return preview.check.why;
    }
    const link = this.deps.link!;
    const id = (this.deps.newId ?? newId)();
    const bytes =
      preview.tool === 'build'
        ? buildCommand(id, link.name, lot, preview.kind, preview.rotation)
        : demolishCommand(id, link.name, lot);
    const timer = setTimeout(() => this.late(id), ANSWER_MS);
    this.waiting.set(id, { tool: preview.tool, lot, timer });
    this.sent++;
    this.status = { state: 'sending', text: SENDING };
    this.changed();
    try {
      await link.send(bytes);
    } catch (err) {
      this.forget(id);
      this.answered++;
      const text =
        err instanceof GatewayError && err.code === 'forbidden'
          ? 'Your sign-in cannot build in this city.'
          : 'That could not be sent. Try again in a moment.';
      this.status = { state: 'refused', text };
      this.changed();
      return text;
    }
    // The answer may already be in: the log can beat the publish's own acknowledgement.
    if (this.waiting.has(id)) {
      this.status = { state: 'waiting', text: WAITING };
      this.changed();
    }
    return null;
  }

  /** A `command` event came off the log. Only ones this page sent are taken. */
  result(id: number, code: number): void {
    const sent = this.waiting.get(id);
    if (!sent) return;
    this.forget(id);
    this.answered++;
    this.status =
      code === RESULT_APPLIED
        ? { state: 'done', text: sent.tool === 'build' ? 'Built.' : 'Taken down.' }
        : { state: 'refused', text: refusal(code) };
    this.changed();
  }

  /** Commands sent and not yet answered. */
  get pending(): number {
    return this.waiting.size;
  }

  private late(id: number): void {
    if (!this.waiting.has(id)) return;
    this.forget(id);
    this.answered++;
    this.status = { state: 'refused', text: 'The city has not answered yet. It may still go through.' };
    this.changed();
  }

  private forget(id: number): void {
    const sent = this.waiting.get(id);
    if (sent) clearTimeout(sent.timer);
    this.waiting.delete(id);
  }
}
