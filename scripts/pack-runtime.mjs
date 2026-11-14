// Packs upstream's WebAssembly runtime (the output of upstream's runtime/build_web.sh) into the
// zip that upstream request 1 asks to attach to the release of the pinned tag, and writes
// runtime.lock.json with its sha256. Run by hand, once per tag:
//
//   node scripts/pack-runtime.mjs <folder with micropython.mjs and micropython.wasm>
//
// Output: .cache/runtime/lms-web-runtime-<tag>.zip, the asset to upload, and runtime.lock.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { RUNTIME_FILES, assetName, assetUrl, CACHE } from './runtime-info.mjs';
import { upstreamInfo } from './upstream-info.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LICENSES = join(ROOT, 'upstream', 'lvgl_mpy_studio', 'gen', 'output', 'licenses');
// A fixed date keeps the zip byte-identical from one run to the next.
const MTIME = new Date('2026-01-01T00:00:00Z');

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/pack-runtime.mjs <folder of runtime/build_web.sh output>');
  process.exit(2);
}
const info = upstreamInfo();
if (!info.tag) {
  console.error('upstream/ is not at a tag: the runtime asset belongs to a release');
  process.exit(1);
}
const files = {};
for (const name of RUNTIME_FILES)
  files[name] = [readFileSync(join(source, name)), { mtime: MTIME }];
for (const name of readdirSync(LICENSES).sort()) {
  files[`licenses/${name}`] = [readFileSync(join(LICENSES, name)), { mtime: MTIME }];
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
const name = assetName(info.tag);
mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, name), zip);
const lock = {
  tag: info.tag,
  asset: name,
  url: assetUrl(info.tag),
  size: zip.length,
  sha256: createHash('sha256').update(zip).digest('hex'),
  files: Object.fromEntries(
    RUNTIME_FILES.map((n) => [n, createHash('sha256').update(files[n][0]).digest('hex')]),
  ),
};
writeFileSync(join(ROOT, 'runtime.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(`${join(CACHE, name)}: ${zip.length} bytes, sha256 ${lock.sha256}`);
