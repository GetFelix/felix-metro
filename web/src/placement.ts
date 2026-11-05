// The building tools without a screen: which tool is held, what it would do on the lot or the crossing under the
// pointer, and what became of the commands it sent. The page draws it (placement-view.ts, ui/build-bar.ts) and feeds it
// the pointer.
import {
  FIRST_KIND,
  RESULT_APPLIED,
  buildCommand,
  canBuild,
  canDemolish,
  canPlaceRoad,
  canRemoveRoad,
  demolishCommand,
  newId,
  nextKind,
  placeRoadCommand,
  refusal,
  removeRoadCommand,
  type Check,
  type Ground,
} from './build';
import { GatewayError } from './gateway';
import { displayName } from './registry';

export type Tool = 'build' | 'demolish' | 'road';

/**
 * What stops commands going out now, from the live connection: signed in without the right, a city the sim has not
 * started, or out of reach.
 */
export type Blocked = 'viewer' | 'idle' | 'down';

/** Who is signed in, as far as saying what to do about a refusal needs. */
export interface SignedIn {
  /** The stand-in's user (`viewer`), or the display name a real provider gives. Empty when the token names no one. */
  readonly user: string;
  /** Whether the provider is the development stand-in, where `?as` picks the user. */
  readonly standIn: boolean;
  /** The city's name at the gateway. */
  readonly city: string;
}

/** The user the stand-in signs in to build. */
export const BUILDER = 'mayor';

/** A part of a message that is a link to open, not text. `label` is the words in the message that carry it. */
export interface Fix {
  label: string;
  user: string;
}

/** The way commands leave the page. */
export interface CommandLink {
  /** The display name commands carry, from the sign-in. */
  readonly name: string;
  readonly signedIn: SignedIn;
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
  /**
   * What core's `Metro.roadCheck` says of a road between two nodes on the live city's land and roads: 0, or the result
   * code the sim would refuse it with. Without it every road is refused.
   */
  roadCheck?(a: number, b: number): number;
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

/** What the road tool points at: the nearest crossing, and the builder's road under the pointer, if any. */
export interface RoadTarget {
  node: number | null;
  segment: number | null;
}

/**
 * The road tool's ghost: the first end, picked or about to be; a road from `a` to `b`; or a builder's road to take away.
 */
export type RoadPreview =
  | { kind: 'start'; a: number; check: Check }
  | { kind: 'lay'; a: number; b: number; check: Check }
  | { kind: 'remove'; segment: number; check: Check };

/** What the panel says about the last thing sent. */
export type Status =
  | { state: 'idle' }
  | { state: 'sending' | 'waiting'; text: string }
  | { state: 'done' | 'refused'; text: string };

/** How long a command may go unanswered before the page says so. The command may still go through. */
export const ANSWER_MS = 20_000;

const no = (why: string): Check => ({ ok: false, why });

const SENDING = 'Sending…';
const WAITING = 'Waiting for the city…';

/** The role that may build in a city, as the dev stack's seed names it. A fork has the role of the city it began from. */
const buildRole = (city: string) => `role:metro-${city.split(/[_~]/)[0]}-build`;

/** The words `watchOnly` links, when it links anything. */
export const FIX_LABEL = `?as=${BUILDER}`;

/** Why a sign-in without the build right cannot build, and the way out. */
export function watchOnly(who: SignedIn): string {
  const first = who.user ? `Signed in as ${who.user}, who can only watch.` : "You're signed in but can only watch.";
  if (!who.standIn) return `${first} Building here needs the build role, ${buildRole(who.city)}.`;
  // The stand-in's builder is already the one refused, so ?as=mayor would only open the same sign-in again.
  if (who.user === BUILDER) return 'Signed in as mayor, who may not build in this city.';
  return `${first} Open ${FIX_LABEL} in a new tab to build.`;
}

/** The cities the dev stack's sim holds back until `dev/city.sh` starts them (`SIM_ON_DEMAND` in dev/compose.yml). */
const HELD_BACK = ['lakeside', 'pier', 'ember'];

/** What to do about a city the sim has not started. */
export function notRunning(city: string): string {
  const name = city.replaceAll('_', '~');
  const start = HELD_BACK.includes(name)
    ? `Start it with dev/city.sh ${name} (./city.sh ${name} in the release bundle).`
    : 'Check that the sim is up, or restart the stack with dev/up.sh (./up.sh in the release bundle).';
  return `${displayName(name)} is not running. ${start}`;
}

/** Why the tools are not usable now, in plain words, or null when they are. */
export function whyNot(deps: Pick<PlacementDeps, 'link' | 'atTip' | 'wantsLive'>): string | null {
  if (!deps.wantsLive || !deps.link) return 'Building needs a live city.';
  if (!deps.atTip()) return 'Go back to live to build.';
  const blocked = deps.link.blocked();
  if (blocked === 'viewer') return watchOnly(deps.link.signedIn);
  if (blocked === 'idle') return notRunning(deps.link.signedIn.city);
  if (blocked === 'down') return 'The city is out of reach. Try again in a moment.';
  return null;
}

type Action = 'build' | 'demolish' | 'lay' | 'remove';

const DONE: Record<Action, string> = {
  build: 'Built.',
  demolish: 'Taken down.',
  lay: 'Road laid.',
  remove: 'Road taken away.',
};

interface Waiting {
  action: Action;
  /** What it was sent for, so the same thing is not sent twice: `lot:7`, `road:3-9` or `segment:120`. */
  what: string;
  timer: ReturnType<typeof setTimeout>;
}

const STILL_GOING = 'Your last change here is still going through.';
const roadKey = (a: number, b: number) => `road:${Math.min(a, b)}-${Math.max(a, b)}`;

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
  private target: RoadTarget | null = null;
  /** The road tool's first end, once picked. */
  private start: number | null = null;
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

  /** The link a message of {@link watchOnly} carries, which only the development sign-in has. */
  fix(): Fix | null {
    const who = this.deps.link?.signedIn;
    return who?.standIn && who.user !== BUILDER ? { label: FIX_LABEL, user: BUILDER } : null;
  }

  /** Pick a tool, or put it away with `null` or by picking the one already held. False, and no change, when blocked. */
  select(tool: Tool | null): boolean {
    if (tool !== null && this.unavailable()) return false;
    this.tool = tool === this.tool ? null : tool;
    this.hovered = null;
    this.target = null;
    this.start = null;
    this.changed();
    return true;
  }

  /** Esc: drop the road's first end if one is picked, else put the tool away. */
  cancel(): void {
    if (this.tool === 'road' && this.start !== null) {
      this.start = null;
      this.changed();
    } else this.select(null);
  }

  /** The tools were in use and cannot be now: put the tool away. */
  drop(): void {
    if (this.tool === null) return;
    this.tool = null;
    this.hovered = null;
    this.target = null;
    this.start = null;
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

  /** What the road tool is over. */
  hoverRoad(target: RoadTarget | null): void {
    const t = this.target;
    if (t === target || (t && target && t.node === target.node && t.segment === target.segment)) return;
    this.target = target;
    this.changed();
  }

  /** The road's first end, or null before one is picked. */
  get roadStart(): number | null {
    return this.start;
  }

  /**
   * What the road tool would do where it points. With no first end, a builder's road under the pointer is taken away and
   * anything else picks the nearest crossing. Once the first end is picked, the pointer only picks the other.
   */
  roadPreview(target: RoadTarget | null = this.target): RoadPreview | null {
    if (this.tool !== 'road') return null;
    const ground = this.deps.ground();
    const mine = (what: string) => [...this.waiting.values()].some((w) => w.what === what);
    if (this.start === null) {
      if (target?.segment != null) {
        const check = mine(`segment:${target.segment}`) ? no(STILL_GOING) : canRemoveRoad(ground, target.segment);
        return { kind: 'remove', segment: target.segment, check };
      }
      if (target?.node == null) return null;
      return { kind: 'start', a: target.node, check: { ok: true } };
    }
    const a = this.start;
    if (target?.node == null) return { kind: 'start', a, check: { ok: true } };
    const b = target.node;
    const code = this.deps.roadCheck?.(a, b) ?? 1;
    const check = mine(roadKey(a, b)) ? no(STILL_GOING) : canPlaceRoad(ground, a, b, code);
    return { kind: 'lay', a, b, check };
  }

  /**
   * Use the road tool where it points: pick the first end, or send the road or the removal. Returns the reason nothing
   * was sent, or null when a command went out or the first end was picked.
   */
  async commitRoad(target: RoadTarget | null = this.target): Promise<string | null> {
    const why = this.unavailable();
    if (why) return why;
    const preview = this.roadPreview(target);
    if (!preview) return 'Pick a crossing first.';
    if (preview.kind === 'start') {
      this.start = preview.a;
      this.changed();
      return null;
    }
    if (!preview.check.ok) return this.turnAway(preview.check.why);
    const link = this.deps.link!;
    const id = (this.deps.newId ?? newId)();
    if (preview.kind === 'lay') {
      // The next road starts afresh; the one sent is drawn when the city lays it.
      this.start = null;
      return this.send(
        id,
        { action: 'lay', what: roadKey(preview.a, preview.b) },
        placeRoadCommand(id, link.name, preview.a, preview.b),
      );
    }
    return this.send(
      id,
      { action: 'remove', what: `segment:${preview.segment}` },
      removeRoadCommand(id, link.name, preview.segment),
    );
  }

  /** What the tool would do on `lot`, or null with no tool held. */
  preview(lot: number | null = this.hovered): Preview | null {
    if (this.tool === null || lot === null) return null;
    const ground = this.deps.ground();
    if (this.tool === 'road') return null;
    const rotation = this.turn ?? this.deps.facing(lot);
    const mine = [...this.waiting.values()].some((w) => w.what === `lot:${lot}`);
    const check: Check = mine
      ? no(STILL_GOING)
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
    if (!preview.check.ok) return this.turnAway(preview.check.why);
    const link = this.deps.link!;
    const id = (this.deps.newId ?? newId)();
    const bytes =
      preview.tool === 'build'
        ? buildCommand(id, link.name, lot, preview.kind, preview.rotation)
        : demolishCommand(id, link.name, lot);
    return this.send(id, { action: preview.tool === 'build' ? 'build' : 'demolish', what: `lot:${lot}` }, bytes);
  }

  /** A command the page refuses itself: told as an answer, and nothing sent. */
  private turnAway(why: string): string {
    this.answered++;
    this.status = { state: 'refused', text: why };
    this.changed();
    return why;
  }

  private async send(id: number, sent: Omit<Waiting, 'timer'>, bytes: Uint8Array): Promise<string | null> {
    const link = this.deps.link!;
    const timer = setTimeout(() => this.late(id), ANSWER_MS);
    this.waiting.set(id, { ...sent, timer });
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
          ? watchOnly(this.deps.link!.signedIn)
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
    const tool = sent.action === 'build' || sent.action === 'demolish' ? sent.action : 'road';
    this.status =
      code === RESULT_APPLIED
        ? { state: 'done', text: DONE[sent.action] }
        : { state: 'refused', text: refusal(code, tool) };
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
