// The files of the connected board as a FileStore, for the board's side of the Files panel and
// for file tabs: each operation is upstream's DeviceSession (list_dir, read_file, write_file,
// make_dir, rename_path, remove_path), queued behind the board's other work as _board_task does.
import type { DeviceController } from '../app/device.ts';
import { type Entry, type FileStore, sortEntries } from '../storage/store.ts';

export const BOARD_STORE = 'board';

/** A path of the store ('' is the root) as the board's absolute path. */
export const boardPath = (path: string): string => `/${path}`;

interface BoardEntry {
  name: string;
  dir: boolean;
  size: number;
}

export class BoardStore implements FileStore {
  readonly id = BOARD_STORE;
  readonly label = 'Board';
  readonly readOnly = false;
  readonly unwatched = true;
  readonly ownView = true;

  constructor(private readonly device: DeviceController) {}

  async list(folder: string): Promise<Entry[]> {
    if (!this.device.connected) return [];
    const entries = await this.device.boardTask<BoardEntry[]>('list_dir', boardPath(folder));
    return sortEntries(entries.map((e) => ({ name: e.name, kind: e.dir ? 'folder' : 'file' })));
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (!this.device.connected) return null;
    try {
      const { data } = await this.device.boardTask<{ data: string }>('read_file', boardPath(path));
      return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
      return null; // no such file, as a store answers
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000) {
      text += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    await this.device.boardTask('write_file', boardPath(path), btoa(text));
  }

  async remove(path: string): Promise<void> {
    await this.device.boardTask('remove_path', boardPath(path));
  }

  async makeFolder(path: string): Promise<void> {
    await this.device.boardTask('make_dir', boardPath(path));
  }

  /** The board can rename in place: os.rename, as board_rename does. */
  async rename(path: string, target: string): Promise<void> {
    await this.device.boardTask('rename_path', boardPath(path), boardPath(target));
  }
}
