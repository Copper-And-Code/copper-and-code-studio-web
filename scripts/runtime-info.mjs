// Where upstream's WebAssembly runtime comes from: an asset of upstream's release for the pinned
// tag (upstream request 1), checked against runtime.lock.json.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RUNTIME_FILES = ['micropython.mjs', 'micropython.wasm'];
export const CACHE = join(ROOT, '.cache', 'runtime');
export const REPOSITORY = 'https://github.com/Copper-And-Code/lvgl-mpy-studio';
export const assetName = (tag) => `lms-web-runtime-${tag}.zip`;
export const assetUrl = (tag) => `${REPOSITORY}/releases/download/${tag}/${assetName(tag)}`;
