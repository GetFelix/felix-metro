import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMessage } from './toast';

interface Fake {
  textContent: string;
  href?: string;
  target?: string;
  rel?: string;
  children?: unknown[];
  replaceChildren(...nodes: unknown[]): void;
}

const fake = (): Fake => ({
  textContent: '',
  replaceChildren(...nodes) {
    this.children = nodes;
  },
});

afterEach(() => vi.unstubAllGlobals());

describe('setMessage', () => {
  const link = { label: '?as=mayor', href: 'http://127.0.0.1:8088/?as=mayor#harbor' };

  it('turns the words of the link into a link to a new tab', () => {
    vi.stubGlobal('document', { createElement: fake });
    const el = fake();
    setMessage(el as never, 'Open ?as=mayor in a new tab to build.', link);
    const [before, a, after] = el.children as [string, Fake, string];
    expect(before).toBe('Open ');
    expect(after).toBe(' in a new tab to build.');
    expect(a).toMatchObject({ textContent: '?as=mayor', href: link.href, target: '_blank', rel: 'noopener' });
  });

  it('is plain text with no link, or when the text lacks its words', () => {
    const el = fake();
    setMessage(el as never, 'Open ?as=mayor', null);
    expect(el.textContent).toBe('Open ?as=mayor');
    setMessage(el as never, 'Pier is not running.', link);
    expect(el.textContent).toBe('Pier is not running.');
    expect(el.children).toBeUndefined();
  });
});
