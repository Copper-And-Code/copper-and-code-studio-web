// Copies upstream's examples/ into public/examples/, served read-only as the web IDE's built-in
// examples, with index.json listing every file.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDir } from './sync-dir.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'upstream', 'examples');
const TARGET = join(ROOT, 'public', 'examples');

function walk(path, found = []) {
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(relative(SOURCE, full).split(sep).join('/'));
  }
  return found;
}

const files = walk(SOURCE);
const content = new Map(files.map((name) => [name, readFileSync(join(SOURCE, name))]));
content.set('index.json', Buffer.from(JSON.stringify({ files }, null, 1) + '\n'));
const written = syncDir(TARGET, content);
console.log(`examples: ${files.length} files in public/examples/, ${written} written`);
