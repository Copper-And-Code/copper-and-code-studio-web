// Folders of the PC, opened with the File System Access API (Chromium only). Their handles are
// kept in IndexedDB, so they come back after a reload; the browser asks again for permission
// the first time each one is used in a session.
import { HandleStore } from './handle-store.ts';

interface SavedFolder {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
      id?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export const canOpenFolders = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lms-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction('folders', mode).objectStore('folders'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
    });
  } finally {
    db.close();
  }
}

/** A folder of the PC: asks for permission before its first use. */
export class PcFolderStore extends HandleStore {
  private permitted = false;

  constructor(
    id: string,
    label: string,
    private readonly handle: FileSystemDirectoryHandle,
  ) {
    super(id, label, handle);
  }

  private async permission(): Promise<void> {
    if (this.permitted) return;
    const handle = this.handle as PermissionHandle;
    let state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'prompt') state = await handle.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') throw new Error(`No permission for the folder ${this.label}`);
    this.permitted = true;
  }

  override async list(folder: string) {
    await this.permission();
    return super.list(folder);
  }
  override async read(path: string) {
    await this.permission();
    return super.read(path);
  }
  override async write(path: string, data: Uint8Array) {
    await this.permission();
    return super.write(path, data);
  }
  override async remove(path: string) {
    await this.permission();
    return super.remove(path);
  }
  override async makeFolder(path: string) {
    await this.permission();
    return super.makeFolder(path);
  }
}

function toStore(folder: SavedFolder): PcFolderStore {
  return new PcFolderStore(folder.id, `PC: ${folder.name}`, folder.handle);
}

async function saved(): Promise<SavedFolder[]> {
  try {
    return await transaction<SavedFolder[]>(
      'readonly',
      (s) => s.getAll() as IDBRequest<SavedFolder[]>,
    );
  } catch {
    return [];
  }
}

export async function savedFolders(): Promise<PcFolderStore[]> {
  return canOpenFolders ? (await saved()).map(toStore) : [];
}

/** Asks the user for a folder of the PC and remembers it. null if the user cancels. */
export async function pickFolder(): Promise<PcFolderStore | null> {
  if (!window.showDirectoryPicker) return null;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'lms-projects' });
  } catch {
    return null; // cancelled
  }
  // The folder itself says whether it is a place already there, not its name: two folders of the
  // PC can both be called "src", and the second must not take the place of the first under the
  // tabs, the recent files and the open project that point to it.
  const known = await saved();
  let existing: SavedFolder | undefined;
  for (const one of known) {
    if (await handle.isSameEntry(one.handle).catch(() => false)) existing ??= one;
  }
  // told apart in the list of places too: "PC: src", "PC: src (2)"
  const names = new Set(known.map((one) => one.name));
  let name = handle.name;
  for (let n = 2; names.has(name); n++) name = `${handle.name} (${n})`;
  const folder: SavedFolder = {
    id: existing?.id ?? `folder:${Date.now().toString(36)}`,
    name: existing?.name ?? name,
    handle,
  };
  try {
    await transaction('readwrite', (s) => s.put(folder));
  } catch {
    // not remembered after a reload, but usable now
  }
  return toStore(folder);
}
