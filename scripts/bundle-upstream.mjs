// Packs upstream's Qt-free Python packages, its data, the py/ glue and the pure-Python packages
// of scripts/python-deps.mjs into one zip for Pyodide
// (PLAN.md 3.2). The zip keeps upstream's layout, so upstream code that finds files relative to
// its own path (runtime/display_driver.py, gen/widgets.json...) works unchanged.
//
// Output: public/python/lms-upstream-<tag>.zip and public/python/bundle.json, which names it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { wheelFiles } from './python-deps.mjs';
import { syncDir } from './sync-dir.mjs';
import { upstreamInfo } from './upstream-info.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPSTREAM = join(ROOT, 'upstream');
const OUT = join(ROOT, 'public', 'python');

/** What goes into the bundle: [source folder, path inside the zip, files or folders]. */
const SOURCES = [
  [
    UPSTREAM,
    '',
    [
      'lvgl_mpy_studio/__init__.py',
      'lvgl_mpy_studio/platform.py',
      'lvgl_mpy_studio/core',
      'lvgl_mpy_studio/device',
      'lvgl_mpy_studio/gen',
      'lvgl_mpy_studio/build',
      'lvgl_mpy_studio/sim',
      'lvgl_mpy_studio/blocks',
      'lvgl_mpy_studio/boards',
      'lvgl_mpy_studio/translations',
      'runtime/display_driver.py',
      'runtime/program',
    ],
  ],
  [join(ROOT, 'py'), '', ['.']],
];

const SKIP = new Set(['__pycache__', '.pytest_cache']);
// A fixed date keeps the zip byte-identical from one build to the next.
const MTIME = new Date('2026-01-01T00:00:00Z');

function walk(path, found = []) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (!SKIP.has(name) && !name.endsWith('.pyc')) walk(join(path, name), found);
    }
  } else {
    found.push(path);
  }
  return found;
}

export function bundleFiles() {
  const files = {};
  for (const [base, prefix, entries] of SOURCES) {
    for (const entry of entries) {
      for (const path of walk(join(base, entry))) {
        const name = prefix + relative(base, path).split(sep).join('/');
        files[name] = [readFileSync(path), { mtime: MTIME }];
      }
    }
  }
  return files;
}

export function bundleName(info = upstreamInfo()) {
  return `lms-upstream-${info.tag ?? `${info.version}-${info.commit}`}.zip`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const info = upstreamInfo();
  const files = bundleFiles();
  for (const [name, data] of Object.entries(await wheelFiles())) {
    if (files[name]) throw new Error(`bundle-upstream: ${name} is both upstream's and a wheel's`);
    files[name] = [data, { mtime: MTIME }];
  }
  const zip = zipSync(
    Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((k) => [k, files[k]]),
    ),
    {
      level: 9,
    },
  );
  const name = bundleName(info);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const index = JSON.stringify({ file: name, sha256, upstream: info }, null, 2) + '\n';
  syncDir(
    OUT,
    new Map([
      [name, zip],
      ['bundle.json', Buffer.from(index)],
    ]),
  );
  console.log(`${name}: ${Object.keys(files).length} files, ${(zip.length / 1024).toFixed(0)} kB`);
}
