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
