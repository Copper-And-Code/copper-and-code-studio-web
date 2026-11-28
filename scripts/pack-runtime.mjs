// Packs one of upstream's WebAssembly builds into the zip attached to upstream's release of the
// pinned tag, and records its sha256 in runtime.lock.json. Run by hand, once per tag:
//
//   node scripts/pack-runtime.mjs runtime  <output of upstream's runtime/build_web.sh>
//   node scripts/pack-runtime.mjs mpyCross <output of scripts/build-mpy-cross-web.sh>
//
// The zip goes to .cache/runtime/, ready to upload; it is byte for byte the same on every run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { ASSETS, CACHE, assetUrl } from './runtime-info.mjs';
import { upstreamInfo } from './upstream-info.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LICENSES = join(ROOT, 'upstream', 'copper_and_code_studio', 'gen', 'output', 'licenses');
const LOCK = join(ROOT, 'runtime.lock.json');
// A zip stores the date and time as the clock of the PC shows them: a date given in UTC made one
// zip in Italy and another in a CI in UTC. In local time it is the same everywhere; one o'clock,
// because the assets published so far were packed in Italy, where that UTC midnight was 01:00,
// and a tag whose runtime did not change must keep its sha256.
const MTIME = new Date(2026, 0, 1, 1, 0, 0);

const [kind, source] = process.argv.slice(2);
const spec = ASSETS[kind];
if (!spec || !source) {
  console.error(`usage: node scripts/pack-runtime.mjs <${Object.keys(ASSETS).join('|')}> <folder>`);
  process.exit(2);
}
const info = upstreamInfo();
if (!info.tag) {
  console.error('upstream/ is not at a tag: the assets belong to a release');
  process.exit(1);
}
const files = {};
for (const name of spec.files) files[name] = [readFileSync(join(source, name)), { mtime: MTIME }];
for (const name of spec.licenses ?? readdirSync(LICENSES).sort()) {
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
const name = spec.asset(info.tag);
mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, name), zip);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const previous = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
// the assets of another tag do not belong to this one
const lock = { tag: info.tag, assets: previous.tag === info.tag ? (previous.assets ?? {}) : {} };
lock.assets[kind] = {
  asset: name,
  url: assetUrl(info.tag, name),
  size: zip.length,
  sha256: sha256(zip),
  files: Object.fromEntries(spec.files.map((n) => [n, sha256(files[n][0])])),
};
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
console.log(`${join(CACHE, name)}: ${zip.length} bytes, sha256 ${lock.assets[kind].sha256}`);
