// The capture mode's options, from the page's URL (docs/capture.md). Everything is off unless the
// URL has ?capture=1, so the IDE in normal use does not change. Read once, before anything else
// reads the settings or the language.

export type CaptureClock = 'real' | 'manual';

export interface CaptureOptions {
  enabled: boolean;
  /** clock=manual: the simulator's clock moves only with lmsCapture.step(ms). */
  clock: CaptureClock;
  /** seed=N: every random source of the simulator starts from N. */
  seed: number | null;
  /** zoom=1.25: the scale of the IDE. */
  zoom: number;
  theme: 'light' | 'dark' | null;
  lang: string | null;
}

const OFF: CaptureOptions = {
  enabled: false,
  clock: 'real',
  seed: null,
  zoom: 1,
  theme: null,
  lang: null,
};

export function parseCaptureOptions(search: string): CaptureOptions {
  const query = new URLSearchParams(search);
  if (query.get('capture') !== '1') return OFF;
  const seed = query.get('seed');
  const zoom = Number(query.get('zoom') ?? '1');
  const theme = query.get('theme');
  return {
    enabled: true,
    clock: query.get('clock') === 'manual' ? 'manual' : 'real',
    seed: seed !== null && /^\d{1,10}$/.test(seed) ? Number(seed) >>> 0 : null,
    zoom: Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 4 ? zoom : 1,
    theme: theme === 'light' || theme === 'dark' ? theme : null,
    lang: query.get('lang'),
  };
}

export const captureOptions: CaptureOptions = parseCaptureOptions(
  globalThis.location?.search ?? '',
);
