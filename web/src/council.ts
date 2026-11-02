// How the page shows the council: what each faction asks for, how the city is doing by it, and the recall countdown.

/** The council event of a record: factions in the order commuters, residents, shops. */
export interface CouncilEvent {
  type: 'council';
  /** City days scored so far; the standings mean nothing until it is 1. */
  days: number;
  /** Days a faction can stay unhappy before the council recalls the mayor. */
  patience: number;
  standings: Standing[];
}

export interface Standing {
  demand: number;
  measure: number;
  satisfaction: number;
  unhappyDays: number;
}

export interface FactionView {
  name: string;
  /** 0 to 100, or `null` before the first day is scored. */
  satisfaction: number | null;
  wants: string;
  /** What the last scored day gave the faction, or `null` before the first. */
  now: string | null;
  unhappy: boolean;
}

export interface CouncilView {
  factions: FactionView[];
  /** The warning to show: the days left before a recall, or that it has come. `null` while no faction is unhappy. */
  recall: { faction: string; daysLeft: number } | null;
}

/** A tick is 15 city seconds, so four to a minute. */
const TICKS_PER_MINUTE = 4;

function minutes(ticks: number): string {
  const m = ticks / TICKS_PER_MINUTE;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** The three factions as the page lists them. `shore` is the city's water edge, or `null` for a city with none. */
export function councilView(event: CouncilEvent, shore: number | null): CouncilView {
  const [commuters, residents, shops] = event.standings;
  if (!commuters || !residents || !shops) return { factions: [], recall: null };
  const scored = event.days > 0;
  const row = (s: Standing, name: string, wants: string, now: string): FactionView => ({
    name,
    satisfaction: scored ? s.satisfaction : null,
    wants,
    now: scored ? now : null,
    unhappy: scored && s.unhappyDays > 0,
  });
  const factions = [
    row(
      commuters,
      'Commuters',
      `Trips to work or school of ${minutes(commuters.demand)} or less`,
      minutes(commuters.measure),
    ),
    row(
      residents,
      shore === null ? 'Residents' : 'Harbor residents',
      `${residents.demand}% of residents with no factory near home`,
      `${residents.measure}%`,
    ),
    row(shops, 'Shops', `${shops.demand} visits a day each`, `${shops.measure}`),
  ];
  let recall: CouncilView['recall'] = null;
  if (scored) {
    // The faction closest to a recall sets the countdown.
    let worst = 0;
    event.standings.forEach((s, i) => {
      if (s.unhappyDays > (event.standings[worst]?.unhappyDays ?? 0)) worst = i;
    });
    const s = event.standings[worst]!;
    if (s.unhappyDays > 0) {
      recall = {
        faction: factions[worst]!.name,
        daysLeft: Math.max(0, event.patience - s.unhappyDays),
      };
    }
  }
  return { factions, recall };
}

/** The warning's words. */
export function recallText(recall: NonNullable<CouncilView['recall']>): string {
  if (recall.daysLeft === 0) return `${recall.faction} have recalled the mayor`;
  const days = recall.daysLeft === 1 ? '1 day' : `${recall.daysLeft} days`;
  return `${recall.faction} will recall the mayor in ${days}`;
}

/** The one line the council shows while folded away. */
export function councilSummary(view: CouncilView): string {
  if (view.recall) return recallText(view.recall);
  const scores = view.factions.flatMap((f) =>
    f.satisfaction === null ? [] : [{ name: f.name, score: f.satisfaction }],
  );
  if (scores.length === 0) return 'Not scored yet';
  const worst = scores.reduce((a, b) => (b.score < a.score ? b : a));
  return `Lowest: ${worst.name} ${worst.score}`;
}

/**
 * Draws the council into `root`, replacing what it held. It is a folded line the player can open, so it does not
 * push the controls below it off a short screen. A redraw keeps it as the player left it; the first draw opens it
 * only if `openFirst`.
 */
export function renderCouncil(root: HTMLElement, view: CouncilView, openFirst: boolean): void {
  const previous = root.firstElementChild as HTMLDetailsElement | null;
  const open = previous ? previous.open : openFirst;
  const rows = view.factions.map((f) => {
    const li = document.createElement('li');
    li.classList.toggle('unhappy', f.unhappy);
    const head = document.createElement('div');
    head.className = 'faction-head';
    const name = document.createElement('b');
    name.textContent = f.name;
    const score = document.createElement('span');
    score.textContent = f.satisfaction === null ? 'not scored yet' : `${f.satisfaction}`;
    head.append(name, score);
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${f.satisfaction ?? 0}%`;
    bar.append(fill);
    const want = document.createElement('small');
    want.textContent = f.now === null ? `Wants: ${f.wants}` : `Wants: ${f.wants}. Now ${f.now}`;
    li.append(head, bar, want);
    return li;
  });
  const list = document.createElement('ul');
  list.append(...rows);
  const summary = document.createElement('summary');
  const title = document.createElement('b');
  title.textContent = 'Council';
  const line = document.createElement('span');
  line.textContent = councilSummary(view);
  line.classList.toggle('recall', view.recall !== null);
  summary.append(title, line);
  const details = document.createElement('details');
  details.open = open;
  details.append(summary, list);
  root.replaceChildren(details);
}
