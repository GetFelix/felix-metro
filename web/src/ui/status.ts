// The clock chip's state: the LIVE pill, the row that shows while the page is in the past, and the notice for a city
// the gateway refuses. Each is drawn by the page's own markup; this only says which is showing.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Status {
  /** The live connection is up (`down` false) or is being re-made; the pill says so. */
  link(down: boolean): void;
  /** The city was refused: no pill, and the notice says why. */
  refused(): void;
  /**
   * The page is showing the past or the live city. The past row replaces the pill, and going back to live brings the
   * pill back, except the first call, since the connection decides whether there is a pill at all.
   */
  past(on: boolean): void;
  /** The text of the Play button, Pause while a playback runs. */
  playLabel(label: string): void;
  /** Whether Play is out of the row, as when there is nothing to play. */
  playHidden(hidden: boolean): void;
  /** How long ago the moment on screen was. */
  ago(text: string): void;
  /** The pace when it is not plain 1x forward, such as `2x` or `Rewind 4x`; empty hides it. */
  rate(text: string): void;
  onPlay(cb: () => void): void;
  onBackToLive(cb: () => void): void;
}

export function createStatus(): Status {
  const pill = byId('pill');
  const notice = byId('notice');
  const row = byId('past');
  const ago = byId('past-ago');
  const rate = byId('past-rate');
  const play = byId<HTMLButtonElement>('play');
  let wasPast: boolean | null = null;
  let agoShown = '';
  let rateShown = '';
  return {
    link(down) {
      pill.textContent = down ? 'Reconnecting…' : 'LIVE';
      pill.classList.toggle('late', down);
      pill.classList.remove('hidden');
    },
    refused() {
      pill.classList.add('hidden');
      notice.classList.remove('hidden');
    },
    past(on) {
      if (on === wasPast) return;
      const first = wasPast === null;
      wasPast = on;
      row.classList.toggle('hidden', !on);
      if (on) pill.classList.add('hidden');
      else if (!first) pill.classList.remove('hidden');
    },
    playLabel(label) {
      if (play.textContent !== label) play.textContent = label;
    },
    playHidden(hidden) {
      play.hidden = hidden;
    },
    ago(text) {
      if (text !== agoShown) ago.textContent = agoShown = text;
    },
    rate(text) {
      if (text === rateShown) return;
      rate.textContent = rateShown = text;
      rate.hidden = text === '';
    },
    onPlay: (cb) => play.addEventListener('click', cb),
    onBackToLive: (cb) => byId('back-live').addEventListener('click', cb),
  };
}
