// Copies the pinned Pyodide release into public/pyodide/, so the site serves it itself rather
// than from a CDN (PLAN.md 3.1): it works offline and as a PWA.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDir } from './sync-dir.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));
const TARGET = join(ROOT, 'public', 'pyodide');
const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
  'package.json',
];

const written = syncDir(
  TARGET,
  new Map(FILES.map((name) => [name, readFileSync(join(SOURCE, name))])),
);
console.log(`pyodide: ${FILES.length} files in public/pyodide/, ${written} written`);
