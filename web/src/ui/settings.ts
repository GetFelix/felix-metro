// What the settings sheet offers for quality, and how a choice maps onto the quality controller.
import type { Tier } from '../params';
import type { Quality } from '../quality';

export type Choice = 'auto' | Tier;

export interface ChoiceInfo {
  value: Choice;
  label: string;
  /** One line under the label, in plain words. */
  hint: string;
}

export const CHOICES: readonly ChoiceInfo[] = [
  { value: 'auto', label: 'Automatic', hint: 'Starts on High and eases off if the city stutters.' },
  { value: 'high', label: 'High', hint: 'The full look, with soft shadows and depth blur.' },
  { value: 'medium', label: 'Medium', hint: 'Lighter on your device, with fewer people on the streets.' },
  { value: 'low', label: 'Low', hint: 'No shadows or blur and the fewest people. Best for older devices.' },
];

export const labelOf = (choice: Choice): string => CHOICES.find((c) => c.value === choice)!.label;

type Running = Pick<Quality, 'mode' | 'tier'>;

/** The option to show as chosen: a tier only when it was picked by hand, in the address or earlier. */
export function selectedChoice(q: Running): Choice {
  return q.mode === 'forced' ? q.tier : 'auto';
}

/** The line under the options: in Automatic, which tier it is on now; otherwise nothing to add. */
export function runningText(q: Running): string {
  return selectedChoice(q) === 'auto' ? `Right now it is on ${labelOf(q.tier)}.` : '';
}

/** Apply an option. A tier is kept for next time; Automatic forgets it. */
export function choose(q: Pick<Quality, 'setTier' | 'setAutomatic'>, choice: Choice): void {
  if (choice === 'auto') q.setAutomatic();
  else q.setTier(choice);
}
