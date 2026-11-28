// The licence notices the site serves (scripts/licenses.mjs) and THIRD_PARTY.md: every package
// that ends up in the site's JavaScript has its notice, and is listed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shippedPackages, thirdPartyNotices } from '../../scripts/licenses.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the licence notices of the site', () => {
  const packages = shippedPackages() as { name: string; version: string; text: string }[];

  it('has the notice of every package the site carries', () => {
    const names = packages.map((one) => one.name);
    // what the first bundle is made of (docs/decisions.md), and what comes with it
    for (const name of [
      'lit',
      'lit-html',
      '@lit/reactive-element',
      '@codemirror/view',
      '@lezer/python',
      'style-mod',
      'w3c-keyname',
      'crelt',
      '@marijn/find-cluster-break',
      '@xterm/xterm',
      'fflate',
      'opentype.js',
      'pyodide',
    ]) {
      expect(names).toContain(name);
    }
    expect(packages.filter((one) => one.text.length < 40)).toEqual([]);
    const notices = thirdPartyNotices() as string;
    for (const one of packages) expect(notices).toContain(`${one.name} ${one.version}`);
    expect(notices).toContain('The FreeType Project');
  });

  it('lists each of them in THIRD_PARTY.md, by its name or by its family', () => {
    const listed = readFileSync(join(ROOT, 'THIRD_PARTY.md'), 'utf8');
    const families = [...listed.matchAll(/`(@[\w-]+)\/\*`/g)].map((match) => `${match[1]}/`);
    const missing = packages
      .map((one) => one.name)
      .filter(
        (name) => !listed.includes(name) && !families.some((family) => name.startsWith(family)),
      );
    expect(missing).toEqual([]);
  });
});
