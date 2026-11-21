// The open project: new, open, save, save as, files changed from outside, unsaved changes.
// It follows upstream's ui/main_files.py (FilesMixin) step by step; the document itself, with its
// revisions and undo, is upstream's logic in Python (py/lms_document.py, temporary).
//
// Upstream reads and writes the project through Python's file system. Before each operation
// that looks at the file on disk, the session copies the file from its store into Pyodide's file
// system (or removes it there, if it is gone); after a save it copies the result back.
import { capture } from '../capture/hub.ts';
import { tr } from '../i18n/tr.ts';
import { PythonCallError, type PythonBridge } from '../py/bridge.ts';
import { addRecent } from '../storage/recent.ts';
import type { Settings } from '../storage/settings.ts';
import { type FileStore, type Location, baseName, parentPath, joinPath } from '../storage/store.ts';

export interface DocState {
  path: string | null;
  modified: boolean;
  projectName: string;
  board: string | null;
  /** MainWindow.run_target: where F5 runs the project. */
  runTarget: 'simulator' | 'board';
  display: { width: number; height: number };
  /** initial: the page the app starts from (Set Initial Page). */
  pages: { id: string; name: string; initial: boolean }[];
  modules: { id: string; name: string }[];
  canUndo: boolean;
  canRedo: boolean;
  undoText: string;
  redoText: string;
}

/** The questions the session asks; the UI answers them with dialogs, tests with a script. */
export interface Prompts {
  /** "Save changes?": Save, Discard or Cancel. */
  unsavedChanges(): Promise<'save' | 'discard' | 'cancel'>;
  /** The file was changed or removed outside the IDE. null is Cancel. */
  externalChange(
    name: string,
    deleted: boolean,
    modified: boolean,
  ): Promise<'reload' | 'copy' | 'overwrite' | null>;
  /** Where to save; suggested is the current file, or a copy's name. null is Cancel. */
  chooseSaveLocation(suggested: Location | null): Promise<Location | null>;
  /** "{name} already exists. Replace it with this project?" */
  confirmReplace(name: string): Promise<boolean>;
  error(title: string, message: string): void;
  status(message: string): void;
  /** A line in the Output panel. */
  output?(text: string): void;
}

export interface Stores {
  get(id: string): FileStore | undefined;
}

const DEFAULTS_KEY = 'defaults/newProject';

/** Where a store's file lives in Pyodide's file system. */
export function pythonPath(location: Location): string {
  return `/ws/${location.store.replace(/[^A-Za-z0-9_-]/g, '-')}/${location.path}`;
}

export class ProjectSession {
  location: Location | null = null;
  state: DocState | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly python: PythonBridge,
    private readonly stores: Stores,
    private readonly prompts: Prompts,
    private readonly settings: Settings,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** "*name — Copper and Code Studio", as the desktop's window title. */
  title(): string {
    const marker = this.state?.modified ? '*' : '';
    const name = this.location ? baseName(this.location.path) : (this.state?.projectName ?? '');
    return `${marker}${name} — Copper and Code Studio`;
  }

  get modified(): boolean {
    return this.state?.modified ?? false;
  }

  /** The project at start-up: a new one, with the user's defaults. */
  async start(): Promise<void> {
    await this.python.ready;
    this.update(await this.python.call<DocState>('doc_new', this.defaults()), null);
  }

  async newProject(board?: string): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    const state = await this.python.call<DocState>('doc_new', this.defaults(), board ?? null);
    this.update(state, null);
    return true;
  }

  async open(location: Location): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    try {
      const data = await this.store(location).read(location.path);
      if (data === null) throw new Error(tr('No such file: {path}', { path: location.path }));
      await this.python.writeFile(pythonPath(location), data);
      this.update(await this.python.call<DocState>('doc_open', pythonPath(location)), location);
    } catch (error) {
      this.prompts.error(tr('Open Error'), message(error));
      return false;
    }
    addRecent(this.settings, location);
    // main_files.py _warn_board_not_in_catalog
    const notice = await this.python.call<string | null>('board_catalog_notice').catch(() => null);
    if (notice) this.prompts.output?.(`${notice}\n`);
    capture.emit('project-opened', {
      store: location.store,
      path: location.path,
      name: this.state?.projectName ?? '',
    });
    return true;
  }

  async save(overwriteExternal = false): Promise<boolean> {
    const location = this.location;
    if (!location || this.store(location).readOnly) return this.saveAs();
    return this.saveTo(location, overwriteExternal, () => {
      this.prompts.status(tr('Saved: {path}', { path: location.path }));
    });
  }

  async saveAs(suggested?: Location): Promise<boolean> {
    const target = await this.prompts.chooseSaveLocation(suggested ?? this.location);
    if (!target) return false;
    const own = sameLocation(target, this.location);
    if (!own && (await this.store(target).read(target.path)) !== null) {
      if (!(await this.prompts.confirmReplace(baseName(target.path)))) return false;
    }
    return this.saveTo(target, false, () => addRecent(this.settings, target));
  }

  async reload(): Promise<boolean> {
    const location = this.location;
    if (!location) return false;
    try {
      await this.syncFromStore(location);
      this.update(await this.python.call<DocState>('doc_reload'), location);
    } catch (error) {
      // A broken outside file must not cost the changes made here.
      this.prompts.error(
        tr('Open Error'),
        tr('The version on disk cannot be opened; your changes stay in the IDE: {error}', {
          error: message(error),
        }),
      );
      return false;
    }
    this.prompts.status(tr('Reloaded: {path}', { path: location.path }));
    return true;
  }

  /** Before something that would drop the project: "Save changes?" */
  async confirmDiscard(): Promise<boolean> {
    if (!this.modified) return true;
    const answer = await this.prompts.unsavedChanges();
    if (answer === 'cancel') return false;
    return answer === 'save' ? this.save() : true;
  }

  async renamePage(pageId: string, name: string): Promise<string[]> {
    const result = await this.python.call<{
      error: string | null;
      warnings: string[];
      state: DocState;
    }>('doc_rename_page', pageId, name);
    this.update(result.state, this.location);
    if (result.error) this.prompts.error(tr('Rename Page'), result.error);
    return result.warnings;
  }

  /** A new state from a change made elsewhere (the Code tab, the modules): same file. */
  adopt(state: DocState): void {
    this.update(state, this.location);
  }

  async undo(): Promise<void> {
    this.update(await this.python.call<DocState>('doc_undo'), this.location);
  }

  async redo(): Promise<void> {
    this.update(await this.python.call<DocState>('doc_redo'), this.location);
  }

  /** The new-project defaults: the desktop's setting, the same JSON. */
  private defaults(): unknown {
    const text = this.settings.get<string | null>(DEFAULTS_KEY, null);
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null;
    }
  }

  private async saveTo(
    target: Location,
    overwriteExternal: boolean,
    done: () => void,
  ): Promise<boolean> {
    const store = this.store(target);
    try {
      // The file as it is now in its store, so that upstream sees an outside change.
      await this.syncFromStore(target);
      const state = await this.python.call<DocState>(
        'doc_save',
        pythonPath(target),
        overwriteExternal,
      );
      const written = await this.python.readFile(pythonPath(target));
      if (!written) throw new Error(tr('No such file: {path}', { path: target.path }));
      try {
        await store.write(target.path, written);
      } catch (error) {
        // Python counted the project as saved; it is not, so it goes back to unsaved.
        this.update(await this.python.call<DocState>('doc_mark_unsaved'), this.location);
        throw error;
      }
      this.update(state, target);
    } catch (error) {
      if (error instanceof PythonCallError && error.type === 'ExternalChangeError') {
        return this.resolveExternalChange(error.deleted ?? false);
      }
      this.prompts.error(tr('Save Error'), message(error));
      return false;
    }
    done();
    return true;
  }

  /** The file was changed or removed from outside: nothing is written without a choice. */
  private async resolveExternalChange(deleted: boolean): Promise<boolean> {
    const location = this.location;
    if (!location) return false;
    const choice = await this.prompts.externalChange(
      baseName(location.path),
      deleted,
      this.modified,
    );
    if (choice === 'reload' && !deleted) return this.reload();
    if (choice === 'copy') return this.saveAs(await this.copyName(location));
    if (choice === 'overwrite') return this.save(true);
    return false;
  }

  /** A free name next to the file: the copy must not land on another project. */
  private async copyName(location: Location): Promise<Location> {
    const store = this.store(location);
    const name = baseName(location.path);
    const dot = name.lastIndexOf('.');
    const [stem, suffix] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const folder = parentPath(location.path);
    let candidate = joinPath(folder, `${stem}-${tr('copy')}${suffix}`);
    for (let number = 2; (await store.read(candidate)) !== null; number++) {
      candidate = joinPath(folder, `${stem}-${tr('copy')}-${number}${suffix}`);
    }
    return { store: location.store, path: candidate };
  }

  private async syncFromStore(location: Location): Promise<void> {
    // upstream writes a temporary file next to the target, so its folder must exist
    const path = pythonPath(location);
    await this.python.makeFolder(path.slice(0, path.lastIndexOf('/')));
    const data = await this.store(location).read(location.path);
    if (data === null) await this.python.removeFile(pythonPath(location));
    else await this.python.writeFile(pythonPath(location), data);
  }

  private store(location: Location): FileStore {
    const store = this.stores.get(location.store);
    if (!store) throw new Error(tr('No such place: {store}', { store: location.store }));
    return store;
  }

  private update(state: DocState, location: Location | null): void {
    this.state = state;
    this.location = location;
    for (const listener of this.listeners) listener();
  }
}

function sameLocation(a: Location, b: Location | null): boolean {
  return b !== null && a.store === b.store && a.path === b.path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
