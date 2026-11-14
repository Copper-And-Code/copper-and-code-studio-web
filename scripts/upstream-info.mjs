// Reads which upstream release the submodule points to. Used at build time by Vite and by tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UPSTREAM = fileURLToPath(new URL('../upstream/', import.meta.url));

function git(...args) {
  try {
    return execFileSync('git', ['-C', UPSTREAM, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** @returns {{ tag: string | null, commit: string, version: string }} */
export function upstreamInfo() {
  const init = readFileSync(`${UPSTREAM}lvgl_mpy_studio/__init__.py`, 'utf8');
  const version = /^__version__\s*=\s*"([^"]+)"/m.exec(init)?.[1] ?? 'unknown';
  const commit = git('rev-parse', '--short=12', 'HEAD') ?? 'unknown';
  const tag = git('describe', '--tags', '--exact-match', 'HEAD');
  return { tag, commit, version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(upstreamInfo()));
}
