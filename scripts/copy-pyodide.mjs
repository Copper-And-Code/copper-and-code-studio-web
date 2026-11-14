// Copies the pinned Pyodide release into public/pyodide/, so the site serves it itself rather
// than from a CDN (PLAN.md 3.1): it works offline and as a PWA.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const name of FILES) copyFileSync(join(SOURCE, name), join(TARGET, name));
console.log(`pyodide: ${FILES.length} files copied to public/pyodide/`);
