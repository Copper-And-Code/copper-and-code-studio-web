import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/memory-store.ts';
import { addRecent, recentFiles } from '../../src/storage/recent.ts';
import { Settings, type SettingsBackend } from '../../src/storage/settings.ts';
import { nameTaken, pathParts, renameStoreEntry, walkFiles } from '../../src/storage/store.ts';
import { exportZip, importZip, readZip } from '../../src/storage/zip.ts';
import { CaseBlindStore } from './case-blind-store.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('paths', () => {
  it('refuses parent folders, empty parts and backslashes', () => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', '.']) {
      expect(() => pathParts(bad), bad).toThrow('Invalid path');
    }
    expect(pathParts('a/b.json')).toEqual(['a', 'b.json']);
  });
});

describe('MemoryStore', () => {
  it('lists folders first, then files, and removes folders with their content', async () => {
    const store = new MemoryStore();
    await store.write('b.json', bytes('1'));
    await store.write('a/x.json', bytes('2'));
    await store.makeFolder('c');
    expect(await store.list('')).toEqual([
      { name: 'a', kind: 'folder' },
      { name: 'c', kind: 'folder' },
      { name: 'b.json', kind: 'file' },
    ]);
    await store.remove('a');
    expect(await walkFiles(store)).toEqual(['b.json']);
    expect(await store.read('a/x.json')).toBeNull();
  });

  it('keeps its own copy of what is written', async () => {
    const store = new MemoryStore();
    const data = bytes('abc');
    await store.write('f', data);
    data[0] = 0;
    expect(new TextDecoder().decode((await store.read('f')) ?? new Uint8Array())).toBe('abc');
  });
});

describe('rename', () => {
  const text = async (store: MemoryStore, path: string) =>
    new TextDecoder().decode((await store.read(path)) ?? new Uint8Array());

  it('moves a file, and a folder with what is in it', async () => {
    const store = new MemoryStore();
    await store.write('a/main.py', bytes('1'));
    await store.write('a/lib/x.py', bytes('2'));
    await store.makeFolder('empty');
    expect(await renameStoreEntry(store, 'a/main.py', 'app.py', 'file')).toBe('a/app.py');
    expect(await renameStoreEntry(store, 'a', 'b', 'folder')).toBe('b');
    expect(await renameStoreEntry(store, 'empty', 'void', 'folder')).toBe('void');
    expect(await walkFiles(store)).toEqual(['b/lib/x.py', 'b/app.py']);
    expect((await store.list('')).map((entry) => entry.name)).toEqual(['b', 'void']);
    expect(await text(store, 'b/lib/x.py')).toBe('2');
  });

  // the old name and the new one are the same folder there: copying and then removing "the old
  // one" removed everything
  for (const Store of [MemoryStore, CaseBlindStore]) {
    it(`changes only the case of a name without losing the files (${Store.name})`, async () => {
      const store = new Store();
      await store.write('Game/main.py', bytes('print(1)'));
      await store.write('Game/lib/x.py', bytes('2'));
      await store.write('Readme.TXT', bytes('3'));
      expect(await nameTaken(store, '', 'game', 'Game')).toBe(false);
      await renameStoreEntry(store, 'Game', 'game', 'folder');
      await renameStoreEntry(store, 'Readme.TXT', 'readme.txt', 'file');
      expect(await walkFiles(store)).toEqual(['game/lib/x.py', 'game/main.py', 'readme.txt']);
      expect(await text(store, 'game/main.py')).toBe('print(1)');
      expect(await text(store, 'readme.txt')).toBe('3');
    });
  }

  it('finds a name taken in another case, by another entry only', async () => {
    const store = new CaseBlindStore();
    await store.write('Game/main.py', bytes('1'));
    await store.write('other/main.py', bytes('2'));
    expect(await nameTaken(store, '', 'GAME', 'other')).toBe(true);
    expect(await nameTaken(store, '', 'GAME', 'Game')).toBe(false);
    expect(await nameTaken(store, '', 'new', 'other')).toBe(false);
    expect(await nameTaken(store, 'Game', 'MAIN.py')).toBe(true);
  });
});

describe('zip', () => {
  it('exports a folder the same way every time, and imports it back byte for byte', async () => {
    const store = new MemoryStore();
    await store.write('p/project.json', bytes('{"a": 1}\n'));
    await store.write('p/sub/helper.py', bytes('X = 1\n'));
    const first = await exportZip(store, 'p');
    expect(await exportZip(store, 'p')).toEqual(first);
    expect((await importZip(store, 'q', first)).sort()).toEqual([
      'q/project.json',
      'q/sub/helper.py',
    ]);
    expect(await store.read('q/sub/helper.py')).toEqual(await store.read('p/sub/helper.py'));
    expect(await exportZip(store, 'q')).toEqual(first);
  });

  it('refuses entries that would leave the folder', () => {
    const zip = zipSync({ '../evil.json': bytes('x') });
    expect(() => readZip(zip)).toThrow('Invalid path');
  });

  it('refuses a zip without files', () => {
    expect(() => readZip(zipSync({}))).toThrow('no files');
  });
});

describe('settings', () => {
  it('works without storage, and when storage throws', () => {
    expect(new Settings(null).get('x', 5)).toBe(5);
    const broken: SettingsBackend = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const settings = new Settings(broken);
    expect(() => settings.set('x', 1)).not.toThrow();
    expect(settings.get('x', 2)).toBe(2);
  });

  it('keeps ten recent files, newest first, without duplicates', () => {
    const map = new Map<string, string>();
    const settings = new Settings({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    });
    for (let i = 0; i < 12; i++) addRecent(settings, { store: 'workspace', path: `${i}.json` });
    addRecent(settings, { store: 'workspace', path: '5.json' });
    const recent = recentFiles(settings).map((l) => l.path);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe('5.json');
    expect(recent.filter((p) => p === '5.json')).toHaveLength(1);
  });
});
