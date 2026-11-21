// Upstream's WebAssembly builds that the site serves: assets of upstream's release for the pinned
// tag (upstream requests 1 and 2), checked against runtime.lock.json.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CACHE = join(ROOT, '.cache', 'runtime');
export const REPOSITORY = 'https://github.com/Copper-And-Code/copper-and-code-studio';

/** kind → the files of the asset, its licence texts, and where the site serves it. */
export const ASSETS = {
  runtime: {
    asset: (tag) => `lms-web-runtime-${tag}.zip`,
    files: ['micropython.mjs', 'micropython.wasm'],
    licenses: null, // all of gen/output/licenses
    out: join(ROOT, 'public', 'runtime'),
  },
  mpyCross: {
    asset: (tag) => `lms-mpy-cross-${tag}.zip`,
    files: ['mpy-cross.mjs', 'mpy-cross.wasm'],
    licenses: ['MicroPython.txt'],
    out: join(ROOT, 'public', 'mpy-cross'),
  },
};

export const assetUrl = (tag, name) => `${REPOSITORY}/releases/download/${tag}/${name}`;
