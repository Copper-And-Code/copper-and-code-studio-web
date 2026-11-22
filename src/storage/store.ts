// Where project files live. Paths are relative, with '/' between folders and no leading '/'.

export interface Entry {
  name: string;
  kind: 'file' | 'folder';
}

export interface FileStore {
  /** 'workspace', 'examples', or 'folder:<n>' for a folder of the PC. */
  readonly id: string;
  readonly label: string;
  readonly readOnly: boolean;
  /**
   * Not looked at for changes made elsewhere: the board, which a read occupies, as the desktop
   * edits a board file in a local copy that only its own tab writes.
   */
  readonly unwatched?: boolean;
  /** Not a place of the file chooser: the board has its own side of the Files panel. */
  readonly ownView?: boolean;
  /** The entries of a folder, folders first, then by name. '' is the root. */
  list(folder: string): Promise<Entry[]>;
  /** The file's bytes, or null if there is no such file. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes the file, creating its folders. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Removes a file, or a folder with everything in it. Nothing happens if it does not exist. */
  remove(path: string): Promise<void>;
  makeFolder(path: string): Promise<void>;
}

/** A file in a store: what recent files and the open project point to. */
export interface Location {
  store: string;
  path: string;
}

export class StoreError extends Error {
  override name = 'StoreError';
}

/** Splits and checks a path: no empty parts, no '.' or '..', no backslashes. */
export function pathParts(path: string): string[] {
  if (path === '') return [];
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('\\')) {
      throw new StoreError(`Invalid path: ${path}`);
    }
  }
  return parts;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function sortEntries(entries: Entry[]): Entry[] {
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  );
}

/** As a file system that ignores the case and the Unicode form of names compares them. */
const folded = (name: string) => name.normalize('NFC').toLowerCase();

/**
 * Another entry of the folder has this name, in any letter case: on Windows, on macOS and on a
 * board's FAT it would be that entry. `except` is the entry being renamed, which may keep its
 * name in another case.
 */
export async function nameTaken(
  store: FileStore,
  folder: string,
  name: string,
  except?: string,
): Promise<boolean> {
  return (await store.list(folder)).some(
    (entry) => entry.name !== except && folded(entry.name) === folded(name),
  );
}

async function copyEntry(
  store: FileStore,
  from: string,
  to: string,
  kind: Entry['kind'],
): Promise<void> {
  const files = kind === 'file' ? [from] : await walkFiles(store, from);
  for (const path of files) {
    const data = await store.read(path);
    if (data) await store.write(to + path.slice(from.length), data);
  }
  if (kind === 'folder' && !files.length) await store.makeFolder(to);
}

/**
 * Renames an entry inside its folder. A store has no rename: the files are copied, then the old
 * ones removed. When only the case of the name changes, the new name is the old entry itself
 * where the file system ignores case, and removing "the old one" after the copy would remove
 * everything: the entry goes through a name of its own first.
 */
export async function renameStoreEntry(
  store: FileStore,
  path: string,
  name: string,
  kind: Entry['kind'],
): Promise<string> {
  const folder = parentPath(path);
  const target = joinPath(folder, name);
  if (folded(baseName(path)) === folded(name)) {
    let parked = joinPath(folder, `${name}.renaming`);
    for (let n = 2; await nameTaken(store, folder, baseName(parked)); n++) {
      parked = joinPath(folder, `${name}.renaming-${n}`);
    }
    await copyEntry(store, path, parked, kind);
    await store.remove(path);
    await copyEntry(store, parked, target, kind);
    await store.remove(parked);
  } else {
    await copyEntry(store, path, target, kind);
    await store.remove(path);
  }
  return target;
}

/** Every file under a folder, recursively, sorted. */
export async function walkFiles(store: FileStore, folder = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await store.list(folder)) {
    const path = joinPath(folder, entry.name);
    if (entry.kind === 'folder') files.push(...(await walkFiles(store, path)));
    else files.push(path);
  }
  return files;
}
