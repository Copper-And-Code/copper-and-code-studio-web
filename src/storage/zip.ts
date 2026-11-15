// Zip import and export of a folder. The same files give the same zip bytes.
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { type FileStore, StoreError, joinPath, pathParts, walkFiles } from './store.ts';

// In local time, as a zip stores dates: the same files give the same zip in every time zone.
const MTIME = new Date(2026, 0, 1);

/** The folder's files in a zip, with paths relative to the folder. */
export async function exportZip(store: FileStore, folder = ''): Promise<Uint8Array> {
  const entries: Zippable = {};
  for (const path of await walkFiles(store, folder)) {
    const data = await store.read(path);
    if (data) entries[folder ? path.slice(folder.length + 1) : path] = [data, { mtime: MTIME }];
  }
  return zipSync(entries, { level: 6 });
}

/** The files of a zip, for checking before they are written. Unsafe paths are refused. */
export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    if (name.endsWith('/')) continue; // a folder entry
    pathParts(name); // throws on '..', absolute paths and backslashes
    if (name.startsWith('__MACOSX/')) continue;
    files.set(name, data);
  }
  if (files.size === 0) throw new StoreError('The zip holds no files');
  return files;
}

/** Writes the zip's files into the folder; returns their paths. */
export async function importZip(
  store: FileStore,
  folder: string,
  zip: Uint8Array,
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, data] of readZip(zip)) {
    const path = joinPath(folder, name);
    await store.write(path, data);
    written.push(path);
  }
  return written;
}
