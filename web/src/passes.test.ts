import { describe, expect, it } from 'vitest';
import { passesFor, without } from './passes';

describe('passesFor', () => {
  it('runs every pass on high', () => {
    expect(passesFor('high')).toEqual(['render', 'ao', 'bloom', 'tilt-shift', 'output', 'grade']);
  });

  it('drops ambient occlusion on medium', () => {
    expect(passesFor('medium')).toEqual(['render', 'bloom', 'tilt-shift', 'output', 'grade']);
  });

  it('drops ambient occlusion and tilt-shift on low', () => {
    expect(passesFor('low')).toEqual(['render', 'bloom', 'output', 'grade']);
  });

  it('keeps the remaining order when trimmed', () => {
    expect(without(passesFor('high'), 'bloom', 'ao')).toEqual(['render', 'tilt-shift', 'output', 'grade']);
  });
});
