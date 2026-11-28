// Writes the service worker of the site (src/pwa/sw.js) into the build, with every file of the
// build listed with its sha256, so the worker caches exactly this deploy. Its version is the hash of
// that list: a deploy that changes no file keeps the same worker, and the browser offers no update.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('../src/pwa/sw.js', import.meta.url));
/** Not cached: the worker itself, and the web versions' own worker. */
const SKIP = new Set(['sw.js', 'preview/sw.js']);

function walk(folder, root = folder, out = []) {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/** The files of a build folder and their sha256, as the worker gets them. */
export function siteFiles(folder) {
  const files = {};
  for (const path of walk(folder)) {
    if (SKIP.has(path)) continue;
    files[path] = createHash('sha256')
      .update(readFileSync(join(folder, path)))
      .digest('hex');
  }
  return files;
}

export function serviceWorker(folder) {
  const files = siteFiles(folder);
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const source = readFileSync(TEMPLATE, 'utf8')
    .replace('const FILES = __LMS_FILES__;', `const FILES = ${JSON.stringify(files, null, 1)};`)
    .replace('const VERSION = __LMS_VERSION__;', `const VERSION = ${JSON.stringify(version)};`);
  if (source.includes('= __LMS_')) throw new Error('src/pwa/sw.js: a placeholder was not replaced');
  writeFileSync(join(folder, 'sw.js'), source);
  return { version, count: Object.keys(files).length };
}

/** The Vite plugin: after the build is written, public/ files included. */
export function swPlugin() {
  let outDir = 'dist';
  return {
    name: 'lms-service-worker',
    apply: 'build',
    configResolved(config) {
      // resolve, not join: an --outDir given whole stays as it is
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { version, count } = serviceWorker(outDir);
      console.log(`sw.js: ${count} files, version ${version}`);
    },
  };
}
