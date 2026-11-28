// The workers of mpy-cross and of the fonts: one that does not load, or stops, must not leave its
// callers waiting for ever (Start, the budget, every call that generates code).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontConverter } from '../../src/fonts/fonts.ts';
import { MpyCross } from '../../src/mpy/mpy-cross.ts';
import type { PythonBridge } from '../../src/py/bridge.ts';

/** A worker the test answers for: what was posted, and events to send back. */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly posted: { id: number }[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    FakeWorker.made.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: { id: number }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe('mpy-cross', () => {
  it('a worker that does not load fails the compilation, and the next one starts another', async () => {
    const cross = new MpyCross();
    const first = cross.compile('main.py', 'x = 1\n');
    const second = cross.compile('ui.py', 'y = 2\n');
    expect(FakeWorker.made).toHaveLength(1);
    FakeWorker.made[0]?.emit('error', { message: 'Failed to fetch the worker script' });
    await expect(first).rejects.toThrow('mpy-cross: Failed to fetch the worker script');
    await expect(second).rejects.toThrow('mpy-cross');
    expect(FakeWorker.made[0]?.terminated).toBe(true);

    const again = cross.compile('main.py', 'x = 1\n');
    expect(FakeWorker.made).toHaveLength(2);
    const worker = FakeWorker.made[1];
    worker?.emit('message', {
      data: { id: worker.posted[0]?.id, ok: true, code: 0, output: '', mpy: new Uint8Array([77]) },
    });
    expect(await again).toEqual({ code: 0, output: '', mpy: new Uint8Array([77]) });
  });
});

describe('the fonts', () => {
  it('a worker that does not load gives the font as failed, and the call that waited goes on', async () => {
    const put: unknown[][] = [];
    const python = {
      call: async (method: string, ...args: unknown[]) => {
        if (method === 'fonts_needed') {
          return [{ key: 'k1', path: '/fonts/a.ttf', size: 20, characters: 'ab' }];
        }
        if (method === 'fonts_put') put.push(args);
        return null;
      },
      readFile: async () => new Uint8Array([1, 2, 3]),
    } as unknown as PythonBridge;
    const fonts = new FontConverter(python);
    const ensured = fonts.ensure();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    FakeWorker.made[0]?.emit('error', { message: 'Failed to fetch the worker script' });
    await ensured;
    expect(put).toEqual([['k1', null, '', 'Failed to fetch the worker script']]);
  });
});
