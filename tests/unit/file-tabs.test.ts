import { describe, expect, it } from 'vitest';
import { FileTabs } from '../../src/app/file-tabs.ts';
import type { MpyCross } from '../../src/mpy/mpy-cross.ts';
import type { PythonBridge } from '../../src/py/bridge.ts';
import { MemoryStore } from '../../src/storage/memory-store.ts';
import type { FileStore } from '../../src/storage/store.ts';
import type { Dialogs } from '../../src/ui/dialogs.ts';

/** A store whose write takes its time, as the board's does over the serial port. */
class SlowStore extends MemoryStore {
  /** Lets the write under way finish. */
  finish: () => void = () => {};
  private entered: () => void = () => {};
  /** Resolves when a write has started. */
  readonly writing = new Promise<void>((resolve) => (this.entered = resolve));

  override async write(path: string, data: Uint8Array) {
    if (path !== 'notes.txt') return super.write(path, data);
    this.entered();
    await new Promise<void>((resolve) => (this.finish = resolve));
    return super.write(path, data);
  }
}

describe('FileTabs', () => {
  it('keeps as unsaved what is typed while the file is being written', async () => {
    const store = new SlowStore('workspace');
    await store.write('other.txt', new Uint8Array());
    store.files.set('notes.txt', new TextEncoder().encode('one'));
    const files = new FileTabs(
      new Map<string, FileStore>([['workspace', store]]),
      {} as Dialogs,
      {} as PythonBridge,
      {} as MpyCross,
      () => {},
      () => {},
    );
    const tab = await files.open({ store: 'workspace', path: 'notes.txt' });
    if (!tab) throw new Error('not opened');
    files.edit(tab, 'one two');
    const saving = files.save(tab);
    await store.writing;
    files.edit(tab, 'one two three');
    store.finish();
    expect(await saving).toBe(true);
    expect(new TextDecoder().decode((await store.read('notes.txt')) ?? undefined)).toBe('one two');
    // "three" is not in the file: the tab still has changes, and closing it asks
    expect(files.modified(tab)).toBe(true);
    expect(files.title(tab)).toBe('notes.txt *');
  });
});
