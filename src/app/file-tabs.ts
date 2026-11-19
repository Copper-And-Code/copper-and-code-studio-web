// Files outside the project in tabs of their own, as upstream's ui/files.py FileTab and
// ui/main_editors.py: open, save, close with the unsaved question, a syntax check with mpy-cross
// for .py files, and a notice when the file changed in its store meanwhile.
//
// A file of the examples cannot be written: saving it copies the whole example folder into the
// workspace first, at the owner's choice, so that a program keeps its modules next to it.
import { capture } from '../capture/hub.ts';
import { tr } from '../i18n/tr.ts';
import type { MpyCross } from '../mpy/mpy-cross.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { type FileStore, type Location, baseName, joinPath, walkFiles } from '../storage/store.ts';
import type { Dialogs } from '../ui/dialogs.ts';

export const MAX_BYTES = 2 * 1024 * 1024; // ui/files.py: a larger file is not opened

export interface SyntaxError {
  line: number;
  message: string;
}

export interface FileTab {
  readonly id: number;
  location: Location;
  /** The text as the store had it when it was read or written: what "modified" compares with. */
  saved: string;
  text: string;
  /** "\r\n" when the file had it: it is written back the same way. */
  newline: string;
  /** The bytes of the store at the last read or write, to see a change made elsewhere. */
  disk: Uint8Array;
  errors: SyntaxError[];
  /** Grows when the text is replaced from the store (reload): the editor loads it again. */
  version: number;
  notice: string;
  /** The notice offers Reload: the file changed elsewhere while it had changes here. */
  offerReload: boolean;
}

/** ui/files.py readable_text: the text, or null for a file too large or not text. */
export function readableText(data: Uint8Array): string | null {
  if (data.length > MAX_BYTES) return null;
  if (data.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const CHECK_DELAY_MS = 800; // ui/files.py: the check runs 800 ms after the last key

export class FileTabs {
  readonly tabs: FileTab[] = [];
  private next = 1;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly stores: Map<string, FileStore>,
    private readonly dialogs: Dialogs,
    private readonly python: PythonBridge,
    private readonly mpyCross: MpyCross,
    private readonly status: (message: string) => void,
    /** A folder of the examples was copied: the Files panel shows the copy. */
    private readonly copied: (folder: Location) => void,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  modified(tab: FileTab): boolean {
    return tab.text !== tab.saved;
  }

  /** "name *", and " [read-only]" for a file of the examples. */
  title(tab: FileTab): string {
    return baseName(tab.location.path) + (this.modified(tab) ? ' *' : '');
  }

  find(location: Location): FileTab | undefined {
    return this.tabs.find(
      (tab) => tab.location.store === location.store && tab.location.path === location.path,
    );
  }

  get(id: number): FileTab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  private store(location: Location): FileStore {
    const store = this.stores.get(location.store);
    if (!store) throw new Error(tr('No such place: {store}', { store: location.store }));
    return store;
  }

  /** The tab of the file, opened if needed; null if it cannot be opened (the user was told). */
  async open(location: Location): Promise<FileTab | null> {
    const existing = this.find(location);
    if (existing) return existing;
    let data: Uint8Array | null;
    try {
      data = await this.store(location).read(location.path);
    } catch (error) {
      void this.dialogs.notice(tr('Open'), message(error));
      return null;
    }
    if (data === null) {
      void this.dialogs.notice(tr('Open'), tr('No such file: {path}', { path: location.path }));
      return null;
    }
    const text = readableText(data);
    if (text === null) {
      void this.dialogs.notice(
        tr('Open'),
        tr('{name} is not a text file the editor can open.', { name: baseName(location.path) }),
      );
      return null;
    }
    const plain = text.replace(/\r\n/g, '\n');
    const tab: FileTab = {
      id: this.next++,
      location,
      saved: plain,
      text: plain,
      newline: text.includes('\r\n') ? '\r\n' : '\n',
      disk: data,
      errors: [],
      version: 1,
      notice: '',
      offerReload: false,
    };
    this.tabs.push(tab);
    this.changed();
    this.scheduleCheck(tab, 0);
    return tab;
  }

  edit(tab: FileTab, text: string): void {
    const wasModified = this.modified(tab);
    tab.text = text;
    if (wasModified !== this.modified(tab)) this.changed();
    this.scheduleCheck(tab, CHECK_DELAY_MS);
  }

  /** "Save changes to {name}?" before the tab goes; false if the user cancelled. */
  async close(tab: FileTab): Promise<boolean> {
    if (this.modified(tab) && !(await this.askSave(tab))) return false;
    clearTimeout(this.timers.get(tab.id));
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.changed();
    return true;
  }

  private async askSave(tab: FileTab): Promise<boolean> {
    const answer = await this.dialogs.message(
      tr('Unsaved Changes'),
      tr('Save changes to {name}?', { name: baseName(tab.location.path) }),
      [
        { label: tr('Save'), value: 'save' as const, primary: true },
        { label: tr('Discard'), value: 'discard' as const },
        { label: tr('Cancel'), value: 'cancel' as const },
      ],
      'cancel' as const,
    );
    if (answer === 'cancel') return false;
    return answer === 'save' ? this.save(tab) : true;
  }

  /** ui/main_editors.py _save_file; a file of the examples goes into a copy of its folder. */
  async save(tab: FileTab): Promise<boolean> {
    try {
      if (this.store(tab.location).readOnly && !(await this.copyExample(tab))) return false;
      const store = this.store(tab.location);
      const now = store.unwatched ? null : await store.read(tab.location.path);
      if (now !== null && !sameBytes(now, tab.disk) && !tab.offerReload) {
        // changed elsewhere since it was read: as the desktop's notice, before anything is lost
        tab.notice = tr(
          'The file changed on disk. Reload loses your changes; Save replaces the other version.',
        );
        tab.offerReload = true;
        tab.disk = now;
        this.changed();
        return false;
      }
      const data = new TextEncoder().encode(tab.text.replace(/\n/g, tab.newline));
      await store.write(tab.location.path, data);
      tab.saved = tab.text;
      tab.disk = data;
      tab.notice = '';
      tab.offerReload = false;
    } catch (error) {
      void this.dialogs.notice(tr('Save'), message(error));
      return false;
    }
    this.status(tr('Saved {path}', { path: tab.location.path }));
    this.changed();
    return true;
  }

  async reload(tab: FileTab): Promise<void> {
    const data = await this.store(tab.location).read(tab.location.path);
    const text = data ? readableText(data) : null;
    if (data === null || text === null) return;
    tab.saved = tab.text = text.replace(/\r\n/g, '\n');
    tab.version++;
    tab.newline = text.includes('\r\n') ? '\r\n' : '\n';
    tab.disk = data;
    tab.notice = '';
    tab.offerReload = false;
    this.changed();
    this.scheduleCheck(tab, 0);
  }

  /**
   * The browser has no file watcher: when the page comes back to the front, each tab looks at its
   * store again, as FileTab._changed_on_disk does when the watcher fires.
   */
  async refreshFromStores(): Promise<void> {
    for (const tab of [...this.tabs]) {
      if (this.store(tab.location).unwatched) continue;
      let now: Uint8Array | null;
      try {
        now = await this.store(tab.location).read(tab.location.path);
      } catch {
        continue;
      }
      if (now === null) {
        tab.notice = tr('The file was deleted on disk: Save writes it again.');
        tab.offerReload = false;
        this.changed();
      } else if (!sameBytes(now, tab.disk)) {
        if (this.modified(tab)) {
          tab.notice = tr(
            'The file changed on disk. Reload loses your changes; Save replaces the other version.',
          );
          tab.offerReload = true;
          tab.disk = now;
          this.changed();
        } else {
          await this.reload(tab);
        }
      }
    }
  }

  /** ui/main_editors.py save_files_in: before a program runs, its files in the editor are saved. */
  async saveFilesIn(folder: Location): Promise<boolean> {
    for (const tab of this.tabs) {
      const inside =
        tab.location.store === folder.store &&
        (folder.path === '' || tab.location.path.startsWith(`${folder.path}/`));
      if (inside && this.modified(tab) && !(await this.save(tab))) return false;
    }
    return true;
  }

  /** When the page closes: whether any file has unsaved changes. */
  get anyModified(): boolean {
    return this.tabs.some((tab) => this.modified(tab));
  }

  /**
   * The example's folder into the workspace, at the owner's choice: every file, then the tab
   * points to the copy. The folder is the top folder of the file in the examples (shell/…).
   */
  private async copyExample(tab: FileTab): Promise<boolean> {
    const source = this.store(tab.location);
    const top = tab.location.path.includes('/') ? (tab.location.path.split('/')[0] ?? '') : '';
    const workspace = this.stores.get('workspace');
    if (!workspace) return false;
    const name = await this.dialogs.askText(
      tr('Copy to the Workspace'),
      tr(
        'The examples cannot be changed. The folder {folder} is copied into the workspace, and your change is saved there. Name of the folder:',
        { folder: top || source.label },
      ),
      top || 'example',
    );
    if (name === null) return false;
    const target = name.trim();
    if (!target || /[/\\]/.test(target) || target === '.' || target === '..') {
      void this.dialogs.notice(tr('Copy to the Workspace'), tr('A name without / or \\, please.'));
      return false;
    }
    const existing = await walkFiles(workspace, '').then((files) =>
      files.filter((path) => path === target || path.startsWith(`${target}/`)),
    );
    if (existing.length) {
      const replace = await this.dialogs.message(
        tr('Copy to the Workspace'),
        tr('{name} already exists in the workspace. Replace its files with those of the example?', {
          name: target,
        }),
        [
          { label: tr('Yes'), value: true },
          { label: tr('No'), value: false, primary: true },
        ],
        false,
      );
      if (!replace) return false;
    }
    const files = top ? await walkFiles(source, top) : [tab.location.path];
    for (const path of files) {
      const data = await source.read(path);
      const relative = top ? path.slice(top.length + 1) : path;
      if (data) await workspace.write(joinPath(target, relative), data);
    }
    const relative = top ? tab.location.path.slice(top.length + 1) : tab.location.path;
    const moved = { store: 'workspace', path: joinPath(target, relative) };
    // the other tabs of the same example follow the copy
    for (const other of this.tabs) {
      if (
        other !== tab &&
        other.location.store === tab.location.store &&
        top &&
        other.location.path.startsWith(`${top}/`)
      ) {
        other.location = {
          store: 'workspace',
          path: joinPath(target, other.location.path.slice(top.length + 1)),
        };
      }
    }
    tab.location = moved;
    tab.disk = (await workspace.read(moved.path)) ?? new Uint8Array();
    this.copied({ store: 'workspace', path: target });
    this.status(tr('Copied {folder} into the workspace', { folder: target }));
    return true;
  }

  private scheduleCheck(tab: FileTab, delay: number): void {
    if (!tab.location.path.endsWith('.py')) return;
    clearTimeout(this.timers.get(tab.id));
    this.timers.set(
      tab.id,
      setTimeout(() => void this.checkSyntax(tab), delay),
    );
  }

  /** ui/files.py check_syntax: mpy-cross's opinion of the text, as {line, message}. */
  async checkSyntax(tab: FileTab): Promise<SyntaxError[]> {
    const text = tab.text;
    let errors: SyntaxError[] = [];
    this.runningChecks++;
    try {
      const name = baseName(tab.location.path);
      const result = await this.mpyCross.compile(name, text);
      if (result.code !== 0) {
        errors = await this.python.call<SyntaxError[]>('syntax_errors', result.output, '/work');
      }
    } catch {
      errors = []; // no mpy-cross: no opinion, as the desktop without its mpy-cross
    } finally {
      this.runningChecks--;
    }
    if (tab.text !== text || !this.tabs.includes(tab)) return errors; // typed meanwhile
    tab.errors = errors;
    this.changed();
    capture.emit('code-checked', {
      file: `file:${tab.location.path}`,
      errors: errors.map((error) => ({ line: error.line, message: error.message })),
    });
    return errors;
  }

  private runningChecks = 0;

  /** No syntax check running: for lmsCapture.idle(). */
  get idle(): boolean {
    return this.runningChecks === 0;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
