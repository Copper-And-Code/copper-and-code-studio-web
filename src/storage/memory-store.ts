import { type Entry, type FileStore, StoreError, pathParts, sortEntries } from './store.ts';

/** A store in memory: for tests, and for what must not be kept. */
export class MemoryStore implements FileStore {
  readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>(['']);

  constructor(
    readonly id = 'memory',
    readonly label = 'Memory',
    readonly readOnly = false,
  ) {}

  async list(folder: string): Promise<Entry[]> {
    const prefix = pathParts(folder).join('/');
    if (!this.folders.has(prefix)) throw new StoreError(`No such folder: ${folder}`);
    const names = new Map<string, Entry>();
    const childOf = (path: string) => {
      if (prefix && !path.startsWith(`${prefix}/`)) return null;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      return rest && !rest.includes('/') ? rest : null;
    };
    for (const path of this.folders) {
      const name = childOf(path);
      if (name) names.set(name, { name, kind: 'folder' });
    }
    for (const path of this.files.keys()) {
      const name = childOf(path);
      if (name) names.set(name, { name, kind: 'file' });
    }
    return sortEntries([...names.values()]);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(pathParts(path).join('/'));
    return data ? new Uint8Array(data) : null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.check();
    const parts = pathParts(path);
    if (parts.length === 0) throw new StoreError('No file name');
    await this.makeFolder(parts.slice(0, -1).join('/'));
    this.files.set(parts.join('/'), new Uint8Array(data));
  }

  async remove(path: string): Promise<void> {
    this.check();
    const key = pathParts(path).join('/');
    this.files.delete(key);
    for (const name of [...this.files.keys()])
      if (name.startsWith(`${key}/`)) this.files.delete(name);
    for (const name of [...this.folders]) {
      if (name === key || name.startsWith(`${key}/`)) this.folders.delete(name);
    }
  }

  async makeFolder(path: string): Promise<void> {
    this.check();
    const parts = pathParts(path);
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }

  private check(): void {
    if (this.readOnly) throw new StoreError(`${this.label} is read-only`);
  }
}
