import { describe, expect, it } from 'vitest';
import { messageLink } from './build-bar';

describe('messageLink', () => {
  it('opens this page as the user that can build, keeping the city', () => {
    expect(messageLink({ label: '?as=mayor', user: 'mayor' }, 'http://127.0.0.1:8088/?as=viewer#harbor')).toEqual({
      label: '?as=mayor',
      href: 'http://127.0.0.1:8088/?as=mayor#harbor',
    });
  });

  it('has no link when there is nothing to fix', () => {
    expect(messageLink(null, 'http://127.0.0.1:8088/')).toBeNull();
  });
});
