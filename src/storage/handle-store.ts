// A store on a FileSystemDirectoryHandle: the browser's private file system (OPFS), which works
// in every engine, or a folder of the PC opened with the File System Access API (Chromium).
import { type Entry, type FileStore, StoreError, pathParts, sortEntries } from './store.ts';
import { tr } from '../i18n/tr.ts';

function isNotFound(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
  );
}

export class HandleStore implements FileStore {
  readonly readOnly = false;

  constructor(
    readonly id: string,
    /** A function for a name in the IDE's language, which can change while it runs. */
    private readonly name: string | (() => string),
    private readonly root: FileSystemDirectoryHandle,
  ) {}

  get label(): string {
    return typeof this.name === 'function' ? this.name() : this.name;
  }

  private async folder(parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
    let handle = this.root;
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  }

  async list(folder: string): Promise<Entry[]> {
    const handle = await this.folder(pathParts(folder));
    const entries: Entry[] = [];
    // values() is in every engine's FileSystemDirectoryHandle, not yet in TypeScript's DOM types.
    const values = (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
    for await (const child of values) {
      // Chromium keeps <name>.crswap beside a file while it writes it: its own, not the user's
      if (child.kind === 'file' && child.name.endsWith('.crswap')) continue;
      entries.push({ name: child.name, kind: child.kind === 'directory' ? 'folder' : 'file' });
    }
    return sortEntries(entries);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const parts = pathParts(path);
    const name = parts.pop();
    if (!name) return null;
    try {
      const file = await (await (await this.folder(parts)).getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const parts = pathParts(path);
    const name = parts.pop();
    if (!name) throw new StoreError('No file name');
    const handle = await (await this.folder(parts, true)).getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') {
      throw new StoreError('This browser cannot write files here');
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(data as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    const parts = pathParts(path);
    const name = parts.pop();
    if (!name) throw new StoreError('Cannot remove the root');
    try {
      await (await this.folder(parts)).removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async makeFolder(path: string): Promise<void> {
    await this.folder(pathParts(path), true);
  }
}

/** The workspace: a folder of the browser's private file system. */
export async function openWorkspace(): Promise<HandleStore> {
  const root = await navigator.storage.getDirectory();
  return new HandleStore(
    'workspace',
    () => tr('Workspace'),
    await root.getDirectoryHandle('workspace', { create: true }),
  );
}

/**
 * The folder of the browser's private storage where upstream's configuration folder is kept
 * (board profiles, blocks): not a place for the user's files, so not in the file chooser.
 */
export async function openConfig(): Promise<HandleStore> {
  const root = await navigator.storage.getDirectory();
  return new HandleStore(
    'config',
    'Configuration',
    await root.getDirectoryHandle('config', { create: true }),
  );
}
