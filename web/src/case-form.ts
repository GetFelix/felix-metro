// The "Case" section of the council: the question, the hints, three choices and a Check button.
import {
  attempt,
  hints,
  hourLabel,
  OPEN_CASE,
  PURPOSES,
  question,
  statusText,
  verdictText,
  type Answer,
  type CaseState,
  type Investigation,
} from './case';

function choice(label: string, options: Array<[string, string]>): { row: HTMLElement; select: HTMLSelectElement } {
  const row = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = label;
  const select = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Choose';
  select.append(none);
  for (const [value, name] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = name;
    select.append(option);
  }
  row.append(text, select);
  return { row, select };
}

/**
 * The section for a case file, drawn once: the council redraws around it, so what the player has chosen stays.
 * `streets` are the city's street names.
 */
export function caseSection(inv: Investigation, streets: string[]): HTMLElement {
  let state: CaseState = OPEN_CASE;
  const root = document.createElement('div');
  root.className = 'case';

  const head = document.createElement('div');
  head.className = 'faction-head';
  const title = document.createElement('b');
  title.textContent = 'Case';
  const status = document.createElement('span');
  status.textContent = statusText(state);
  head.append(title, status);

  const asking = document.createElement('small');
  asking.textContent = question(inv);
  const clues = document.createElement('ul');
  clues.className = 'clues';
  for (const text of hints(inv)) {
    const li = document.createElement('li');
    li.textContent = text;
    clues.append(li);
  }

  const street = choice(
    'Street',
    [...streets].sort().map((s) => [s, s]),
  );
  const hour = choice(
    'Hour',
    Array.from({ length: 24 }, (_, h): [string, string] => [String(h), hourLabel(h)]),
  );
  const purpose = choice(
    'Purpose',
    PURPOSES.map((p): [string, string] => [p.value, p.label]),
  );

  const check = document.createElement('button');
  check.type = 'button';
  check.textContent = 'Check';
  const verdict = document.createElement('small');
  verdict.className = 'verdict';

  const answer = (): Answer => ({
    street: street.select.value || null,
    hour: hour.select.value === '' ? null : Number(hour.select.value),
    purpose: purpose.select.value || null,
  });
  check.addEventListener('click', () => {
    const given = answer();
    state = attempt(inv, state, given);
    status.textContent = statusText(state);
    status.className = state.solved ? 'won' : '';
    verdict.textContent = verdictText(state, given);
    if (state.solved) {
      check.disabled = true;
      for (const { select } of [street, hour, purpose]) select.disabled = true;
    }
  });

  root.append(head, asking, clues, street.row, hour.row, purpose.row, check, verdict);
  return root;
}
