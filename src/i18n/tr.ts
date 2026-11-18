// Messages are upstream's English source strings, translated with upstream's own catalogue
// (lvgl_mpy_studio/translations/it.json) exactly as its core/i18n.py tr() does: the English of
// the code is the key, {name} placeholders are filled after translating, and a text already
// translated is taken back to its English first. The strings that exist only on the web are in
// src/i18n/it-web.json, proposed upstream (docs/upstream-requests.md).
//
// The language is the desktop's setting "language" (Settings → Language). Without one, the
// browser's language decides, as a web page is expected to do.
import { captureOptions } from '../capture/options.ts';
import upstreamIt from '../../upstream/lvgl_mpy_studio/translations/it.json';
import { Settings } from '../storage/settings.ts';
import webIt from './it-web.json';

/** core/i18n.py LANGUAGES, in the order of the desktop's Language menu. */
export const LANGUAGES: Record<string, string> = { it: 'Italiano', en: 'English' };
export const DEFAULT_LANGUAGE = 'en';

const catalogs: Record<string, Record<string, string>> = {
  it: { ...(webIt as Record<string, string>), ...(upstreamIt as Record<string, string>) },
};

let sources: Map<string, string> | null = null;
/** From a translated text to its English one. */
function sourceOf(text: string): string {
  if (!sources) {
    sources = new Map();
    for (const name of Object.keys(catalogs)) {
      for (const [source, value] of Object.entries(catalogs[name] ?? {}))
        sources.set(value, source);
    }
  }
  return sources.get(text) ?? text;
}

function initial(): string {
  // capture mode: the language of the URL, or English, never the user's or the browser's
  if (captureOptions.enabled)
    return captureOptions.lang && captureOptions.lang in LANGUAGES
      ? captureOptions.lang
      : DEFAULT_LANGUAGE;
  const saved = new Settings().get<string | null>('language', null);
  if (saved && saved in LANGUAGES) return saved;
  const browser = (globalThis.navigator?.language ?? '').slice(0, 2).toLowerCase();
  return browser in LANGUAGES ? browser : DEFAULT_LANGUAGE;
}

let current = initial();

export function language(): string {
  return current;
}

/** core/i18n.py set_language: an unknown language is English. */
export function setLanguage(code: string): string {
  current = code in LANGUAGES ? code : DEFAULT_LANGUAGE;
  return current;
}

/** The text in the chosen language, with {name} placeholders filled in, as upstream's tr(). */
export function tr(text: string, values: Record<string, string | number> = {}): string {
  // an English text of the code stays itself, also when it equals the translation of another one
  const english = Object.values(catalogs).some((catalog) => text in catalog);
  const source = english ? text : sourceOf(text);
  const translated = current === 'en' ? source : (catalogs[current]?.[source] ?? source);
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * A stable name for a control, from its English text whatever the language: "Run Program…" is
 * run-program. The capture mode's data-capture names of the menus (docs/capture.md).
 */
export function captureName(text: string): string {
  const english = Object.values(catalogs).some((catalog) => text in catalog);
  return (english ? text : sourceOf(text))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Marks a text to translate later, where it is written before the language is known (a table's
 * headings, a list of fields): it stays English here, and tr() of it translates it when shown.
 * scripts/tr-strings.mjs finds these as it finds tr().
 */
export function N_(text: string): string {
  return text;
}

/** For tests: whether a text has a translation. */
export function translated(text: string, code = 'it'): boolean {
  return text in (catalogs[code] ?? {});
}
