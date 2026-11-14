// Brings a folder to exactly the files given: writes only the files that changed and removes
// the others. A running dev server keeps serving the folder; deleting and recreating it under
// Vite makes it answer with the page instead of the files.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

function walk(path, root, found) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full, root, found);
    else found.push(relative(root, full).split(sep).join('/'));
  }
  return found;
}

/** files: Map of relative path → Buffer or Uint8Array. Returns how many were written. */
export function syncDir(target, files) {
  mkdirSync(target, { recursive: true });
  let written = 0;
  for (const [name, data] of files) {
    const path = join(target, name);
    if (existsSync(path) && Buffer.from(data).equals(readFileSync(path))) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    written++;
  }
  for (const name of walk(target, target, [])) {
    if (!files.has(name)) rmSync(join(target, name));
  }
  return written;
}
