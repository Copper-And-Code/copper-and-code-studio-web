// The built-in examples: upstream's examples/ folder, served read-only by the site
// (scripts/bundle-examples.mjs writes examples/index.json, the list of its files).
import {
  type Entry,
  type FileStore,
  StoreError,
  joinPath,
  pathParts,
  sortEntries,
} from './store.ts';

export class ExamplesStore implements FileStore {
  readonly id = 'examples';
  readonly label = 'Examples';
  readonly readOnly = true;
  private index: Promise<string[]> | undefined;

  constructor(
    private readonly base = new URL(`${import.meta.env.BASE_URL}examples/`, location.href),
  ) {}

  private files(): Promise<string[]> {
    this.index ??= fetch(new URL('index.json', this.base)).then(async (response) => {
      if (!response.ok) throw new StoreError(`Examples: HTTP ${response.status}`);
      return ((await response.json()) as { files: string[] }).files;
    });
    return this.index;
  }

  async list(folder: string): Promise<Entry[]> {
    const prefix = pathParts(folder).join('/');
    const names = new Map<string, Entry>();
    for (const file of await this.files()) {
      if (prefix && !file.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? file.slice(prefix.length + 1) : file;
      const [name, ...more] = rest.split('/');
      if (name) names.set(name, { name, kind: more.length ? 'folder' : 'file' });
    }
    return sortEntries([...names.values()]);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const key = pathParts(path).join('/');
    if (!(await this.files()).includes(key)) return null;
    const response = await fetch(new URL(key, this.base));
    if (!response.ok) throw new StoreError(`${key}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async write(path: string): Promise<void> {
    throw new StoreError(`Examples are read-only: ${joinPath('', path)}`);
  }

  async remove(path: string): Promise<void> {
    throw new StoreError(`Examples are read-only: ${path}`);
  }

  async makeFolder(path: string): Promise<void> {
    throw new StoreError(`Examples are read-only: ${path}`);
  }
}
