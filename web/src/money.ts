// How the page writes the city's funds.

/** Funds as whole dollars with thousands separators; a negative amount keeps its sign in front of the dollar. */
export function money(amount: number): string {
  const whole = Math.round(Math.abs(amount)).toLocaleString('en-US');
  return `${amount < 0 ? '-' : ''}$${whole}`;
}
