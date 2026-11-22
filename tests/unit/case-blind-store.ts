// A store that ignores the case of names and keeps the one first written, as the file systems
// of Windows and macOS do under a folder of the PC: "game" is the entry "Game".
import { MemoryStore } from '../../src/storage/memory-store.ts';
import type { Entry } from '../../src/storage/store.ts';

export class CaseBlindStore extends MemoryStore {
  /** The path with each part spelled as the entry that is there, if one is. */
  private async real(path: string): Promise<string> {
    const parts: string[] = [];
    for (const part of path ? path.split('/') : []) {
      let entries: Entry[] = [];
      try {
        entries = await super.list(parts.join('/'));
      } catch {
        // no such folder yet: the rest is new
      }
      const found = entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
      parts.push(found?.name ?? part);
    }
    return parts.join('/');
  }

  override async list(folder: string) {
    return super.list(await this.real(folder));
  }
  override async read(path: string) {
    return super.read(await this.real(path));
  }
  override async write(path: string, data: Uint8Array) {
    return super.write(await this.real(path), data);
  }
  override async remove(path: string) {
    return super.remove(await this.real(path));
  }
  override async makeFolder(path: string) {
    return super.makeFolder(await this.real(path));
  }
}
