// The licence notices the site serves (public/licenses/): the IDE's own licence, and the notices
// of what the build puts into its JavaScript, whose comments the minifier removes. MIT and BSD ask
// that their notice goes with every copy; the About box links both files.
//
// The packages are the `dependencies` of package.json with all they depend on, as installed.
// What comes in other files of the site has its notices next to it and is only named here.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'licenses');

/** Not in the site: type definitions, and what Pyodide uses only under Node. */
const NOT_SHIPPED = (name) => name.startsWith('@types/') || name === 'ws';
/** Without a licence file in the package: where its licence is. */
const ELSEWHERE = {
  pyodide:
    'Mozilla Public License 2.0: https://www.mozilla.org/MPL/2.0/\n' +
    'Source: https://github.com/pyodide/pyodide\n' +
    'Pyodide carries CPython and its standard library, under the PSF License Agreement:\n' +
    'https://docs.python.org/3/license.html',
  '@lit-labs/ssr-dom-shim': 'BSD-3-Clause, as the other packages of Lit below.',
};

function packageFolder(name, from) {
  const require = createRequire(from);
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // a package that does not export its package.json: up from its entry
    let folder = dirname(require.resolve(name));
    for (;;) {
      const file = join(folder, 'package.json');
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return folder;
      const parent = dirname(folder);
      if (parent === folder) throw new Error(`licenses: the folder of ${name} was not found`);
      folder = parent;
    }
  }
}

/** Every package the site's JavaScript is made of: name, version, licence, its notice. */
export function shippedPackages() {
  const found = new Map();
  const walk = (name, from) => {
    if (NOT_SHIPPED(name)) return;
    const folder = packageFolder(name, from);
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) return;
    const file = readdirSync(folder)
      .sort()
      .find((entry) => /^(licen[cs]e|copying)/i.test(entry));
    const text = file ? readFileSync(join(folder, file), 'utf8').trim() : ELSEWHERE[manifest.name];
    if (!text) throw new Error(`licenses: ${key} has no licence file: add it to ELSEWHERE`);
    found.set(key, {
      name: manifest.name,
      version: manifest.version,
      licence: String(manifest.license ?? ''),
      text,
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      walk(dependency, join(folder, 'package.json'));
    }
  };
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const name of Object.keys(root.dependencies)) walk(name, join(ROOT, 'package.json'));
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const RULE = '-'.repeat(78);

export function thirdPartyNotices() {
  const packages = shippedPackages();
  const fontConverter = packageFolder('lv_font_conv', join(ROOT, 'package.json'));
  const fontConverterVersion = JSON.parse(
    readFileSync(join(fontConverter, 'package.json'), 'utf8'),
  ).version;
  const parts = [
    'Copper and Code Studio Web: third-party software in this site',
    '',
    'The IDE itself is under the GNU General Public License, version 3 or later: LICENSE.txt, next',
    'to this file. What follows is the software of others that the site carries, each under its',
    'own licence.',
    '',
    'In files of their own, with their notices next to them:',
    '- the WebAssembly runtime of the simulator (MicroPython, LVGL, lvgl-bindings,',
    '  lvgl-micropython, SDL2): ../runtime/licenses/',
    '- mpy-cross in WebAssembly (MicroPython): ../mpy-cross/licenses/',
    '- mpremote and platformdirs, with upstream Copper and Code Studio: inside the archive of',
    '  ../python/, each with the licence file of its package',
    '',
    'In the JavaScript of the site:',
    '',
    RULE,
    `FreeType, built to WebAssembly by lv_font_conv ${fontConverterVersion}`,
    'The FreeType Project License (FTL): https://freetype.org/license.html',
    RULE,
    'Portions of this software are copyright © The FreeType Project (www.freetype.org).',
    'All rights reserved.',
    '',
    RULE,
    `lv_font_conv ${fontConverterVersion} (the build of FreeType above)`,
    RULE,
    readFileSync(join(fontConverter, 'LICENSE'), 'utf8').trim(),
    '',
  ];
  for (const one of packages) {
    parts.push(RULE, `${one.name} ${one.version}${one.licence ? ` (${one.licence})` : ''}`, RULE);
    parts.push(one.text, '');
  }
  return parts.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  let written = 0;
  const put = (name, text) => {
    const file = join(OUT, name);
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
    writeFileSync(file, text);
    written++;
  };
  put('LICENSE.txt', readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  put('THIRD-PARTY.txt', thirdPartyNotices());
  console.log(`licenses: 2 files in public/licenses/, ${written} written`);
}
