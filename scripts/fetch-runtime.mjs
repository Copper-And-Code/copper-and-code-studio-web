// Brings upstream's WebAssembly runtime into public/runtime/: the release asset named in
// runtime.lock.json, downloaded once into .cache/runtime/ and checked against its sha256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { CACHE } from './runtime-info.mjs';
import { syncDir } from './sync-dir.mjs';
import { upstreamInfo } from './upstream-info.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'runtime');

function fail(message) {
  console.error(`fetch-runtime: ${message}`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(join(ROOT, 'runtime.lock.json'), 'utf8'));
const info = upstreamInfo();
if (info.tag !== lock.tag) {
  fail(
    `runtime.lock.json is for ${lock.tag}, upstream/ is at ${info.tag ?? 'no tag'}: ` +
      'pack the runtime of the new tag with scripts/pack-runtime.mjs',
  );
}
const cached = join(CACHE, lock.asset);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
let zip = existsSync(cached) ? readFileSync(cached) : null;
if (!zip || sha256(zip) !== lock.sha256) {
  console.log(`fetch-runtime: downloading ${lock.url}`);
  let response;
  try {
    response = await fetch(lock.url);
  } catch (error) {
    fail(`cannot download ${lock.url}: ${error.message}`);
  }
  if (!response.ok) {
    fail(
      `${lock.url}: HTTP ${response.status}. The runtime is an asset of upstream's release ` +
        `${lock.tag} (docs/upstream-requests.md, request 1).`,
    );
  }
  zip = Buffer.from(await response.arrayBuffer());
  if (sha256(zip) !== lock.sha256) {
    fail(`${lock.asset}: sha256 ${sha256(zip)}, runtime.lock.json says ${lock.sha256}`);
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, zip);
}
const files = new Map(Object.entries(unzipSync(new Uint8Array(zip))));
for (const [name, expected] of Object.entries(lock.files)) {
  const data = files.get(name);
  if (!data || sha256(data) !== expected) fail(`${name} in ${lock.asset} does not match the lock`);
}
const written = syncDir(OUT, files);
console.log(`fetch-runtime: ${lock.asset} (${lock.tag}) in public/runtime/, ${written} written`);
