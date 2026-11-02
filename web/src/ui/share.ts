// The button under the settings button that copies a link to the moment on screen.
import { toast } from './toast';

export const SHARE_LABEL = 'Share this moment';
export const SHARE_COPIED = 'Link copied.';
export const SHARE_NONE = 'There is nothing to share yet.';

const LINK = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12l4-4M7.5 9.5l-1.8 1.8a2.5 2.5 0 003.5 3.5l1.8-1.8M12.5 10.5l1.8-1.8a2.5 2.5 0 00-3.5-3.5L9 7"/></svg>`;

/** Put the button in the corner. `link` is the address of the moment now, or null when there is none to share yet. */
export function createShare(link: () => string | null): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.id = 'share-button';
  button.title = SHARE_LABEL;
  button.setAttribute('aria-label', SHARE_LABEL);
  button.innerHTML = LINK;
  document.querySelector('.corner')!.append(button);
  button.addEventListener('click', () => {
    const url = link();
    if (!url) return void toast(SHARE_NONE, 3000);
    // The clipboard is missing off a secure page, and refused in some browsers; the prompt lets the person copy by hand.
    (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('no clipboard'))).then(
      () => toast(SHARE_COPIED, 3000),
      () => {
        try {
          prompt('Copy this link', url);
        } catch {
          // A blocked prompt leaves the person with nothing to do; the link is still in the address bar they came from.
        }
      },
    );
  });
}
