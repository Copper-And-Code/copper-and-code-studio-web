// Before any test: the server on the port serves this folder's build, and the build is not older
// than its sources. Outside CI Playwright keeps a server it finds on the port (reuseExistingServer)
// and then builds nothing: a preview left open, also by another copy of the repository, which
// answers at the same address, would have the tests judge some other code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..', '..');
/** What the build is made of, apart from upstream/ and the packages, which change with a pin. */
const SOURCES = ['src', 'py', 'scripts', 'index.html', 'vite.config.ts', 'package.json'];

/** The latest change under a path, and the file it is of. */
function newest(path: string): { at: number; file: string } {
  const stat = statSync(path);
  if (!stat.isDirectory()) return { at: stat.mtimeMs, file: path };
  let latest = { at: 0, file: path };
  for (const name of readdirSync(path)) {
    const inner = newest(join(path, name));
    if (inner.at > latest.at) latest = inner;
  }
  return latest;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const url = config.webServer?.url;
  if (!url) return;
  const stop = `Stop the server at ${url} and run the tests again: they build and start their own.`;
  // sw.js lists every file of a build with its sha256 (scripts/sw-plugin.mjs)
  const worker = join(ROOT, 'dist', 'sw.js');
  const served = await (await fetch(new URL('sw.js', url))).text();
  if (served !== readFileSync(worker, 'utf8')) {
    throw new Error(`The server at ${url} serves another build than dist/ of this folder. ${stop}`);
  }
  const built = statSync(worker).mtimeMs;
  const source = SOURCES.map((name) => newest(join(ROOT, name))).find((one) => one.at > built);
  if (source) {
    throw new Error(
      `${source.file.slice(ROOT.length + 1)} changed after dist/ was built, ` +
        `and a server already running is not built again. ${stop}`,
    );
  }
}
