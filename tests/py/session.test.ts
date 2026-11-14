// The project session with upstream's document in Pyodide: the flows of ui/main_files.py.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PythonBridge } from '../../src/py/bridge.ts';
import { ProjectSession, type Prompts } from '../../src/project/session.ts';
import { MemoryStore } from '../../src/storage/memory-store.ts';
import { recentFiles } from '../../src/storage/recent.ts';
import { Settings, type SettingsBackend } from '../../src/storage/settings.ts';
import type { Location } from '../../src/storage/store.ts';
import { inProcessBridge } from './in-process.ts';
import { ROOT } from './pyodide-node.mjs';

const DEMO = readFileSync(join(ROOT, 'upstream/examples/demo.json'));
const text = (data: Uint8Array | null) => new TextDecoder().decode(data ?? new Uint8Array());

class MapBackend implements SettingsBackend {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** Answers from a script; what was asked is recorded. */
class ScriptedPrompts implements Prompts {
  asked: string[] = [];
  errors: string[] = [];
  statuses: string[] = [];
  unsaved: 'save' | 'discard' | 'cancel' = 'cancel';
  external: 'reload' | 'copy' | 'overwrite' | null = null;
  saveLocation: Location | null = null;
  replace = false;
  suggested: Location | null = null;
  async unsavedChanges() {
    this.asked.push('unsaved');
    return this.unsaved;
  }
  async externalChange(name: string, deleted: boolean) {
    this.asked.push(`external:${name}:${deleted ? 'deleted' : 'changed'}`);
    return this.external;
  }
  async chooseSaveLocation(suggested: Location | null) {
    this.asked.push('save-as');
    this.suggested = suggested;
    return this.saveLocation;
  }
  async confirmReplace(name: string) {
    this.asked.push(`replace:${name}`);
    return this.replace;
  }
  error(title: string, message: string) {
    this.errors.push(`${title}: ${message}`);
  }
  status(message: string) {
    this.statuses.push(message);
  }
}

let python: PythonBridge;
let workspace: MemoryStore;
let examples: MemoryStore;
let prompts: ScriptedPrompts;
let settings: Settings;
let session: ProjectSession;

beforeEach(async () => {
  python ??= await inProcessBridge();
  workspace = new MemoryStore('workspace', 'Workspace');
  examples = new MemoryStore('examples', 'Examples');
  await examples.write('demo.json', DEMO);
  Object.defineProperty(examples, 'readOnly', { value: true });
  prompts = new ScriptedPrompts();
  settings = new Settings(new MapBackend());
  const stores = new Map([
    ['workspace', workspace],
    ['examples', examples],
  ]);
  session = new ProjectSession(python, stores, prompts, settings);
  await session.start();
}, 120_000);

const firstPage = () => session.state?.pages[0]?.id ?? '';

describe('new project', () => {
  it('is for the STM32H7_CORE V1.3 at 1024x600 without saved defaults', async () => {
    expect(session.state?.board).toBe('stm32h7_core_v1_3_1024x600');
    expect(session.state?.display).toEqual({ width: 1024, height: 600 });
    expect(session.modified).toBe(false);
  });

  it('follows the saved defaults, or the board chosen', async () => {
    settings.set('defaults/newProject', JSON.stringify({ board: 'esp32_4848s040_480' }));
    await session.newProject();
    expect(session.state?.display).toEqual({ width: 480, height: 480 });
    await session.newProject('waveshare_rp2350_touch_lcd_4_240');
    expect(session.state?.board).toBe('waveshare_rp2350_touch_lcd_4_240');
  });
});

describe('open, edit, save', () => {
  it('an example opens, and its first save asks where, in the workspace', async () => {
    expect(await session.open({ store: 'examples', path: 'demo.json' })).toBe(true);
    expect(session.title()).toBe('demo.json — LVGL MPY Studio');
    await session.renamePage(firstPage(), 'Welcome');
    expect(session.title()).toBe('*demo.json — LVGL MPY Studio');

    prompts.saveLocation = { store: 'workspace', path: 'mine/demo.json' };
    const saved0 = await session.save();
    expect(prompts.errors).toEqual([]);
    expect(saved0).toBe(true);
    expect(prompts.asked).toEqual(['save-as']);
    expect(session.title()).toBe('demo.json — LVGL MPY Studio');
    expect(session.location).toEqual({ store: 'workspace', path: 'mine/demo.json' });
    const saved = JSON.parse(text(await workspace.read('mine/demo.json'))) as {
      pages: { name: string }[];
      projectId: string;
    };
    expect(saved.pages[0]?.name).toBe('Welcome');
    // Save As makes a separate project
    expect(saved.projectId).not.toBe((JSON.parse(text(DEMO)) as { projectId: string }).projectId);
    expect(text(await examples.read('demo.json'))).toBe(text(DEMO));
    expect(recentFiles(settings)[0]).toEqual({ store: 'workspace', path: 'mine/demo.json' });

    // opened again from the workspace, the change is there
    await session.newProject();
    await session.open({ store: 'workspace', path: 'mine/demo.json' });
    expect(session.state?.pages[0]?.name).toBe('Welcome');
  });

  it('saves the open file in place, with the bytes upstream writes', async () => {
    await workspace.write('demo.json', DEMO);
    await session.open({ store: 'workspace', path: 'demo.json' });
    await session.renamePage(firstPage(), 'Start');
    expect(await session.save()).toBe(true);
    expect(prompts.asked).toEqual([]);
    expect(prompts.statuses).toEqual(['Saved: demo.json']);
    const reply = text(await workspace.read('demo.json'));
    expect(reply.endsWith('}\n')).toBe(true);
    expect(JSON.parse(reply)).toMatchObject({ pages: [{ name: 'Start' }] });
  });

  it('undo back to the saved state is not a change', async () => {
    await session.open({ store: 'examples', path: 'demo.json' });
    await session.renamePage(firstPage(), 'Welcome');
    expect(session.state?.undoText).toBe('Rename Page');
    await session.undo();
    expect(session.modified).toBe(false);
    await session.redo();
    expect(session.modified).toBe(true);
  });

  it('refuses a page name that is already taken', async () => {
    await session.open({ store: 'examples', path: 'demo.json' });
    const names = session.state?.pages.map((page) => page.name) ?? [];
    if (names.length < 2) return; // the demo has one page: nothing to collide with
    await session.renamePage(firstPage(), names[1] ?? '');
    expect(prompts.errors[0]).toContain('already exists');
    expect(session.modified).toBe(false);
  });
});

describe('unsaved changes', () => {
  beforeEach(async () => {
    await session.open({ store: 'examples', path: 'demo.json' });
    await session.renamePage(firstPage(), 'Changed');
  });

  it('Cancel keeps the project', async () => {
    prompts.unsaved = 'cancel';
    expect(await session.newProject()).toBe(false);
    expect(session.state?.pages[0]?.name).toBe('Changed');
  });

  it('Discard drops it', async () => {
    prompts.unsaved = 'discard';
    expect(await session.newProject()).toBe(true);
    expect(session.location).toBeNull();
  });

  it('Save saves it first', async () => {
    prompts.unsaved = 'save';
    prompts.saveLocation = { store: 'workspace', path: 'kept.json' };
    expect(await session.newProject()).toBe(true);
    expect(text(await workspace.read('kept.json'))).toContain('"Changed"');
  });
});

describe('a file changed outside the IDE', () => {
  beforeEach(async () => {
    await workspace.write('demo.json', DEMO);
    await session.open({ store: 'workspace', path: 'demo.json' });
    await session.renamePage(firstPage(), 'Mine');
  });

  it('is never overwritten without a choice', async () => {
    await workspace.write('demo.json', new TextEncoder().encode(text(DEMO) + ' '));
    prompts.external = null;
    expect(await session.save()).toBe(false);
    expect(prompts.asked).toEqual(['external:demo.json:changed']);
    expect(text(await workspace.read('demo.json'))).toBe(text(DEMO) + ' ');
    expect(session.modified).toBe(true);
  });

  it('Save a copy writes next to it, under a free name', async () => {
    await workspace.write('demo.json', new TextEncoder().encode(text(DEMO) + ' '));
    await workspace.write('demo-copy.json', DEMO);
    prompts.external = 'copy';
    prompts.saveLocation = null;
    await session.save();
    expect(prompts.suggested).toEqual({ store: 'workspace', path: 'demo-copy-2.json' });
  });

  it('Overwrite replaces it', async () => {
    await workspace.write('demo.json', new TextEncoder().encode(text(DEMO) + ' '));
    prompts.external = 'overwrite';
    expect(await session.save()).toBe(true);
    expect(text(await workspace.read('demo.json'))).toContain('"Mine"');
  });

  it('Reload takes the version on disk', async () => {
    const outside = JSON.parse(text(DEMO)) as { pages: { name: string }[] };
    (outside.pages[0] as { name: string }).name = 'Outside';
    await workspace.write('demo.json', new TextEncoder().encode(JSON.stringify(outside)));
    prompts.external = 'reload';
    expect(await session.save()).toBe(true);
    expect(session.state?.pages[0]?.name).toBe('Outside');
    expect(session.modified).toBe(false);
  });

  it('a deleted file can be recreated', async () => {
    await workspace.remove('demo.json');
    prompts.external = 'overwrite';
    expect(await session.save()).toBe(true);
    expect(prompts.asked).toEqual(['external:demo.json:deleted']);
    expect(text(await workspace.read('demo.json'))).toContain('"Mine"');
  });
});

describe('save as', () => {
  it('asks before replacing another file, and writes nothing on No', async () => {
    await session.open({ store: 'examples', path: 'demo.json' });
    await workspace.write('other.json', new TextEncoder().encode('{}'));
    prompts.saveLocation = { store: 'workspace', path: 'other.json' };
    prompts.replace = false;
    expect(await session.saveAs()).toBe(false);
    expect(prompts.asked).toEqual(['save-as', 'replace:other.json']);
    expect(text(await workspace.read('other.json'))).toBe('{}');
  });

  it('a store that fails to write leaves the project unsaved', async () => {
    await session.open({ store: 'examples', path: 'demo.json' });
    workspace.write = async () => {
      throw new Error('disk full');
    };
    prompts.saveLocation = { store: 'workspace', path: 'full.json' };
    expect(await session.saveAs()).toBe(false);
    expect(prompts.errors).toEqual(['Save Error: disk full']);
    expect(session.modified).toBe(true);
    expect(session.location).toEqual({ store: 'examples', path: 'demo.json' });
  });
});

describe('opening', () => {
  it('a broken file is an Open Error and the project stays', async () => {
    await workspace.write('broken.json', new TextEncoder().encode('{ not json'));
    expect(await session.open({ store: 'workspace', path: 'broken.json' })).toBe(false);
    expect(prompts.errors[0]).toMatch(/^Open Error: /);
    expect(session.location).toBeNull();
  });
});
