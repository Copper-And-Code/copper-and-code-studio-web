import { describe, expect, it } from 'vitest';
import { ToneFilter } from '../../src/sim/tones.ts';

describe('ToneFilter', () => {
  it('takes the markers out and plays them, as sim/session.py', () => {
    const tones: [number, number][] = [];
    const filter = new ToneFilter((frequency, ms) => tones.push([frequency, ms]));
    expect(filter.feed('score 1\n\x1bLVSIM_TONE 440 40\nscore 2\n')).toBe('score 1\nscore 2\n');
    expect(filter.feed('\x1bLVSIM_TONE 0 0\r\n')).toBe('');
    expect(tones).toEqual([
      [440, 40],
      [0, 0],
    ]);
  });

  it('keeps a marker cut in two for the next piece', () => {
    const tones: [number, number][] = [];
    const filter = new ToneFilter((frequency, ms) => tones.push([frequency, ms]));
    expect(filter.feed('a\x1bLVSIM_TO')).toBe('a');
    expect(filter.feed('NE 880 20\nb')).toBe('b');
    expect(tones).toEqual([[880, 20]]);
  });

  it('lets other escape sequences through', () => {
    const filter = new ToneFilter(() => {});
    expect(filter.feed('\x1b[1;32mgreen\x1b[0m')).toBe('\x1b[1;32mgreen\x1b[0m');
  });
});
