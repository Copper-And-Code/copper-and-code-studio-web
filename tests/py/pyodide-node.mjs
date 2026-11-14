// Pyodide under Node for the tests: the same pinned release the site serves.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function startPyodide() {
  return loadPyodide({ stdout: () => {}, stderr: () => {} });
}

/** Copies a folder of the PC into Pyodide's in-memory file system. Nothing is written back. */
export function copyIn(
  py,
  source,
  target,
  skip = new Set(['.git', '__pycache__', 'node_modules']),
) {
  py.FS.mkdirTree(target);
  for (const name of readdirSync(source)) {
    if (skip.has(name)) continue;
    const from = join(source, name);
    const to = `${target}/${name}`;
    const stat = statSync(from);
    if (stat.isDirectory()) copyIn(py, from, to, skip);
    else if (stat.isFile()) py.FS.writeFile(to, readFileSync(from));
  }
}
