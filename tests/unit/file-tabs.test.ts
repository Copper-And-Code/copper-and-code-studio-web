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

  it('a tab closed again while its save is being written closes that tab only', async () => {
    const store = new SlowStore('board');
    store.files.set('notes.txt', new TextEncoder().encode('one'));
    store.files.set('other.txt', new TextEncoder().encode('kept'));
    // the answers to "Save changes to …?", in the order they are asked
    const answers = ['save', 'discard'];
    const asked: string[] = [];
    const dialogs = {
      message: async (_title: string, text: string) => {
        asked.push(text);
        return answers.shift();
      },
      notice: async () => {},
    } as unknown as Dialogs;
    const files = new FileTabs(
      new Map<string, FileStore>([['board', store]]),
      dialogs,
      {} as PythonBridge,
      {} as MpyCross,
      () => {},
      () => {},
    );
    const notes = await files.open({ store: 'board', path: 'notes.txt' });
    const other = await files.open({ store: 'board', path: 'other.txt' });
    if (!notes || !other) throw new Error('not opened');
    files.edit(notes, 'one two');
    files.edit(other, 'kept, with changes');
    // ×, Save: the board takes seconds to write; × again meanwhile
    const first = files.close(notes);
    await store.writing;
    const second = files.close(notes);
    store.finish();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // the tab was asked about once, and the other tab is still there with its text
    expect(asked).toEqual(['Save changes to notes.txt?']);
    expect(files.tabs).toEqual([other]);
    expect(files.modified(other)).toBe(true);
    expect(new TextDecoder().decode((await store.read('notes.txt')) ?? undefined)).toBe('one two');
  });

  it('a file opened again while it is being read is one tab', async () => {
    // a file of the board takes seconds to read: a second double click comes meanwhile
    const store = new MemoryStore('board');
    store.files.set('main.py', new TextEncoder().encode('print(1)\n'));
    const read = store.read.bind(store);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    store.read = async (path) => {
      await released;
      return read(path);
    };
    const files = new FileTabs(
      new Map<string, FileStore>([['board', store]]),
      {} as Dialogs,
      {} as PythonBridge,
      { compile: async () => ({ code: 0, output: '', mpy: null }) } as unknown as MpyCross,
      () => {},
      () => {},
    );
    const first = files.open({ store: 'board', path: 'main.py' });
    const second = files.open({ store: 'board', path: 'main.py' });
    release();
    const tab = await first;
    expect(tab).not.toBeNull();
    expect(await second).toBe(tab);
    expect(files.tabs).toHaveLength(1);
    // once read, it can be opened and closed as before
    expect(await files.open({ store: 'board', path: 'main.py' })).toBe(tab);
  });

  it('the tabs of the files under a renamed folder follow it', async () => {
    const store = new MemoryStore('board');
    for (const path of ['flash/app/main.py', 'flash/app/lib/x.py', 'flash/apple.py']) {
      store.files.set(path, new TextEncoder().encode('pass\n'));
    }
    const files = new FileTabs(
      new Map<string, FileStore>([['board', store]]),
      {} as Dialogs,
      {} as PythonBridge,
      { compile: async () => ({ code: 0, output: '', mpy: null }) } as unknown as MpyCross,
      () => {},
      () => {},
    );
    for (const path of store.files.keys()) await files.open({ store: 'board', path });
    files.renamed('board', 'flash/app', 'flash/game');
    // "apple.py" starts with the old name and is not in the folder
    expect(files.tabs.map((tab) => tab.location.path)).toEqual([
      'flash/game/main.py',
      'flash/game/lib/x.py',
      'flash/apple.py',
    ]);
    // a file renamed is its own tab only, and another place is not touched
    files.renamed('board', 'flash/apple.py', 'flash/pear.py');
    files.renamed('workspace', 'flash/game', 'flash/other');
    expect(files.tabs.map((tab) => tab.location.path)).toEqual([
      'flash/game/main.py',
      'flash/game/lib/x.py',
      'flash/pear.py',
    ]);
  });
});
