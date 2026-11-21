// Phase 10: the capture mode's options from the URL, the stable names of the controls, and the hub
// that sends events and frames only in capture mode (docs/capture.md).
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureHub } from '../../src/capture/hub.ts';
import { parseCaptureOptions } from '../../src/capture/options.ts';
import { captureName, setLanguage, tr } from '../../src/i18n/tr.ts';

describe('capture options', () => {
  it('is off without capture=1, whatever else the URL says', () => {
    expect(parseCaptureOptions('?clock=manual&seed=3').enabled).toBe(false);
    expect(parseCaptureOptions('?capture=0').enabled).toBe(false);
  });

  it('reads the clock, the seed, the zoom, the theme, the language and the editor', () => {
    expect(
      parseCaptureOptions(
        '?capture=1&clock=manual&seed=42&zoom=1.25&theme=dark&lang=it&editor=plain',
      ),
    ).toEqual({
      enabled: true,
      clock: 'manual',
      seed: 42,
      zoom: 1.25,
      theme: 'dark',
      lang: 'it',
      editor: 'plain',
    });
  });

  it('keeps the defaults for values it does not know', () => {
    expect(
      parseCaptureOptions('?capture=1&clock=fast&seed=-1&zoom=9&theme=blue&editor=bare'),
    ).toEqual({
      enabled: true,
      clock: 'real',
      seed: null,
      zoom: 1,
      theme: null,
      lang: null,
      editor: 'normal',
    });
  });
});

describe('captureName', () => {
  afterEach(() => setLanguage('en'));

  it('is the English text, in lower case with dashes', () => {
    expect(captureName('Run Program…')).toBe('run-program');
    expect(captureName('About Copper and Code Studio')).toBe('about-copper-and-code-studio');
    expect(captureName('Module name, without .py:')).toBe('module-name-without-py');
  });

  it('is the same name in Italian', () => {
    setLanguage('it');
    const label = tr('Project Settings…');
    expect(label).not.toBe('Project Settings…');
    expect(captureName(label)).toBe('project-settings');
  });

  it('finds a label drawn with a colon after the text, in Italian too', () => {
    setLanguage('it');
    const label = `${tr('New Folder')}:`;
    expect(label).not.toBe('New Folder:');
    expect(captureName(label)).toBe('new-folder');
    expect(captureName(tr('Name:'))).toBe('name');
  });
});

describe('CaptureHub', () => {
  const frame = { width: 1, height: 1, number: 1, pixels: new Uint8ClampedArray(4) };

  it('sends events with a sequence number, and frames, when on', () => {
    const hub = new CaptureHub(true);
    const events: unknown[] = [];
    const frames: unknown[] = [];
    hub.onEvent((event) => events.push(event));
    const off = hub.onFrame((value) => frames.push(value));
    hub.emit('project-opened', { path: 'a.json' });
    hub.emit('page-changed', { page: 'p1' });
    hub.frame(frame);
    off();
    hub.frame(frame);
    expect(events).toEqual([
      { type: 'project-opened', seq: 1, path: 'a.json' },
      { type: 'page-changed', seq: 2, page: 'p1' },
    ]);
    expect(frames).toEqual([frame]);
    expect(hub.last).toBe(frame);
  });

  it('sends nothing and keeps nothing when off', () => {
    const hub = new CaptureHub(false);
    const seen: unknown[] = [];
    hub.onEvent((event) => seen.push(event));
    hub.onFrame((value) => seen.push(value));
    hub.emit('simulator-started');
    hub.frame(frame);
    expect(seen).toEqual([]);
    expect(hub.last).toBeNull();
  });
});
