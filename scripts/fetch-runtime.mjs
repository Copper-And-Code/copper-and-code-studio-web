// Brings upstream's WebAssembly builds into public/: each asset named in runtime.lock.json,
// downloaded once into .cache/runtime/ and checked against its sha256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { ASSETS, CACHE } from './runtime-info.mjs';
import { syncDir } from './sync-dir.mjs';
import { upstreamInfo } from './upstream-info.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fail(message) {
  console.error(`fetch-runtime: ${message}`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(join(ROOT, 'runtime.lock.json'), 'utf8'));
const info = upstreamInfo();
if (info.tag !== lock.tag) {
  fail(
    `runtime.lock.json is for ${lock.tag}, upstream/ is at ${info.tag ?? 'no tag'}: ` +
      'pack the assets of the new tag with scripts/pack-runtime.mjs',
  );
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
for (const [kind, spec] of Object.entries(ASSETS)) {
  const entry = lock.assets?.[kind];
  if (!entry) fail(`runtime.lock.json has no ${kind}`);
  const cached = join(CACHE, entry.asset);
  let zip = existsSync(cached) ? readFileSync(cached) : null;
  if (!zip || sha256(zip) !== entry.sha256) {
    console.log(`fetch-runtime: downloading ${entry.url}`);
    let response;
    try {
      response = await fetch(entry.url);
    } catch (error) {
      fail(`cannot download ${entry.url}: ${error.message}`);
    }
    if (!response.ok) {
      fail(
        `${entry.url}: HTTP ${response.status}. It is an asset of upstream's release ` +
          `${lock.tag} (docs/upstream-requests.md, requests 1 and 2).`,
      );
    }
    zip = Buffer.from(await response.arrayBuffer());
    if (sha256(zip) !== entry.sha256) {
      fail(`${entry.asset}: sha256 ${sha256(zip)}, runtime.lock.json says ${entry.sha256}`);
    }
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, zip);
  }
  const files = new Map(Object.entries(unzipSync(new Uint8Array(zip))));
  for (const [name, expected] of Object.entries(entry.files)) {
    const data = files.get(name);
    if (!data || sha256(data) !== expected)
      fail(`${name} in ${entry.asset} does not match the lock`);
  }
  const written = syncDir(spec.out, files);
  console.log(
    `fetch-runtime: ${entry.asset} in ${spec.out.slice(ROOT.length)}, ${written} written`,
  );
}
