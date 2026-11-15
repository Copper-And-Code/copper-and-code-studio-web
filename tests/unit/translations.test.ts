// Phase 9: the Italian of the web IDE is upstream's it.json, with the same keys, and the texts that
// exist only on the web are in src/i18n/it-web.json (proposed upstream). Every text of the code
// has a translation, and tr() works as upstream's core/i18n.py tr().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trStrings } from '../../scripts/tr-strings.mjs';
import { setLanguage, tr } from '../../src/i18n/tr.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, string>;
const upstream = read('upstream/lvgl_mpy_studio/translations/it.json');
const web = read('src/i18n/it-web.json');
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  const { texts } = trStrings(ROOT) as { texts: Map<string, string> };

  it('has an Italian text for every text of the code', () => {
    const missing = [...texts].filter(([text]) => !(text in upstream) && !(text in web));
    expect(missing).toEqual([]);
  });

  it('keeps only web texts in it-web.json, each one used', () => {
    expect(Object.keys(web).filter((text) => text in upstream)).toEqual([]);
    expect(Object.keys(web).filter((text) => !texts.has(text))).toEqual([]);
  });

  it('keeps the placeholders of each web text', () => {
    const wrong = Object.entries(web).filter(
      ([source, value]) => placeholders(source).join() !== placeholders(value).join(),
    );
    expect(wrong).toEqual([]);
  });
});

describe('tr', () => {
  afterEach(() => setLanguage('en'));

  it('translates, fills placeholders, and leaves English as it is', () => {
    setLanguage('it');
    expect(tr('Settings')).toBe('Impostazioni');
    expect(tr('Close {name}', { name: 'a.py' })).toBe('Chiudi a.py');
    expect(tr('A text nobody translated')).toBe('A text nobody translated');
    setLanguage('en');
    expect(tr('Settings')).toBe('Settings');
    expect(tr('Close {name}', { name: 'a.py' })).toBe('Close a.py');
  });

  it('takes an Italian text back to English, as upstream does', () => {
    setLanguage('en');
    expect(tr('Impostazioni')).toBe('Settings');
    // "File" is an English text of the code, and also the Italian of "Files": it stays itself
    expect(tr('File')).toBe('File');
  });

  it('treats an unknown language as English', () => {
    expect(setLanguage('fr')).toBe('en');
  });
});
