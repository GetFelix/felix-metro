import { afterEach, describe, expect, it } from 'vitest';
import { joinRecorded } from './join-frames.mjs';

const frames = (joinedFlags) => joinedFlags.map((joined, i) => ({ t: i * 230, joined, tick: i }));

describe('joinRecorded', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it('waits while no frame has shown the join, however long the page has been live', () => {
    globalThis.window = { __frames: frames([false, false, false, false, false, false, false, false]) };
    expect(joinRecorded(4)).toBe(false);
  });

  it('waits for frames after the join frame, which the check compares', () => {
    globalThis.window = { __frames: frames([false, false, false, true, true, true]) };
    expect(joinRecorded(4)).toBe(false);
  });

  it('is true once the join frame and the frames after it are recorded', () => {
    globalThis.window = { __frames: frames([false, false, false, true, true, true, true, true]) };
    expect(joinRecorded(4)).toBe(true);
  });

  it('does not count a record that starts already joined', () => {
    globalThis.window = { __frames: frames([true, true, true, true, true, true]) };
    expect(joinRecorded(4)).toBe(false);
  });
});
