import { describe, expect, it } from 'vitest';
import { formatCamera, momentLink, parseCamera } from './moments';
import { parseParams } from './params';

const view = { x: 1.25, z: -3, distance: 21.5, azimuth: 0.785, polar: 0.9 };

describe('parseCamera', () => {
  it('reads five numbers and gives back what formatCamera wrote', () => {
    expect(parseCamera(formatCamera(view))).toEqual(view);
  });

  it('refuses anything else, so a mangled link opens the usual view', () => {
    for (const bad of [null, '', '1,2,3', '1,2,3,4,5,6', '1,2,3,4,x', '1,2,,4,5', 'NaN,2,3,4,5', 'Infinity,2,3,4,5'])
      expect(parseCamera(bad), String(bad)).toBeNull();
  });
});

describe('momentLink', () => {
  it('names the tick and the view and keeps the city', () => {
    const link = momentLink(
      'https://metro.example/?districts=3&layout=city&still&hud&t=12&tier=low#harbor',
      4321.7,
      view,
    );
    expect(link).toBe('https://metro.example/?districts=3&layout=city&at=4321&cam=1.25,-3,21.5,0.785,0.9#harbor');
  });

  it('replaces the moment a shared link was already at', () => {
    const link = momentLink('https://metro.example/?at=10&cam=0,0,9,0,1#harbor', 20, view);
    expect(link).toBe('https://metro.example/?at=20&cam=1.25,-3,21.5,0.785,0.9#harbor');
  });

  it('is read back by the page as the same moment', () => {
    const link = new URL(momentLink('http://localhost:5173/?gateway=ws://127.0.0.1:8787/ws#bay', 77, view));
    expect(parseParams(link.search, link.hash)).toMatchObject({
      at: 77,
      cam: view,
      gateway: 'ws://127.0.0.1:8787/ws',
      seed: 'bay',
    });
  });

  it('adds the resident being followed, and nothing when there is none', () => {
    const link = momentLink('https://metro.example/?districts=3&follow=9#harbor', 4321, view, 412);
    expect(link).toBe('https://metro.example/?districts=3&at=4321&cam=1.25,-3,21.5,0.785,0.9&follow=412#harbor');
    expect(momentLink('https://metro.example/?follow=9#harbor', 4321, view)).not.toContain('follow');
    expect(momentLink('https://metro.example/#harbor', 4321, view, 0)).toContain('&follow=0');
  });

  it('is read back as the same resident', () => {
    const link = new URL(momentLink('http://localhost/#bay', 77, view, 15));
    expect(parseParams(link.search, link.hash)).toMatchObject({ at: 77, cam: view, follow: 15 });
  });

  it('starts the query when there is nothing to keep', () => {
    expect(momentLink('http://localhost/', 5, view)).toBe('http://localhost/?at=5&cam=1.25,-3,21.5,0.785,0.9');
  });
});
