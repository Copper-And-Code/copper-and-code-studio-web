// The IDE's controller: the places where files live, the open project, the menus. The questions
// and their wording are the desktop's (ui/main_files.py).
import { tr } from '../i18n/tr.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { ProjectSession, type Prompts } from '../project/session.ts';
import { download, pickFiles } from '../storage/download.ts';
import { ExamplesStore } from '../storage/examples-store.ts';
import { canOpenFolders, pickFolder, savedFolders } from '../storage/folders.ts';
import { openWorkspace } from '../storage/handle-store.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import { recentFiles } from '../storage/recent.ts';
import type { Settings } from '../storage/settings.ts';
import { type FileStore, type Location, baseName, joinPath, walkFiles } from '../storage/store.ts';
import { exportZip, importZip, readZip } from '../storage/zip.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import type { Menu, MenuItem } from '../ui/menu-bar.ts';
import { RunController, type RunView } from './run.ts';

const isProject = (name: string) => name.toLowerCase().endsWith('.json');

export class Studio {
  readonly stores = new Map<string, FileStore>();
  readonly session: ProjectSession;
  /** Running in the simulator: set when the shell has its Simulator tab. */
  run: RunController | null = null;
  /** Set when the browser's private storage could not be opened: files live until a reload. */
  workspaceProblem: string | null = null;
  private readonly statusListeners = new Set<(message: string) => void>();

  constructor(
    readonly python: PythonBridge,
    private readonly dialogs: Dialogs,
    private readonly settings: Settings,
  ) {
    this.session = new ProjectSession(python, this.stores, this.prompts(), settings);
  }

  async start(): Promise<void> {
    try {
      this.addStore(await openWorkspace());
    } catch (error) {
      this.workspaceProblem = String(error instanceof Error ? error.message : error);
      this.addStore(new MemoryStore('workspace', tr('Workspace (not kept)')));
    }
    this.addStore(new ExamplesStore());
    for (const folder of await savedFolders()) this.addStore(folder);
    await this.session.start();
    if (this.workspaceProblem) {
      void this.dialogs.notice(
        tr('Workspace'),
        tr(
          'The browser does not let the IDE keep files ({error}). Projects can be opened and saved, but they are lost when the page is closed: export them as files or as a zip.',
          { error: this.workspaceProblem },
        ),
      );
    }
  }

  /** The Simulator tab and the Output panel of the shell. */
  attachRun(view: RunView, screen: HTMLElement): RunController {
    this.run = new RunController(
      {
        python: this.python,
        session: this.session,
        stores: this.stores,
        settings: this.settings,
        dialogs: this.dialogs,
        view,
      },
      screen,
    );
    return this.run;
  }

  onStatus(listener: (message: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private status(message: string): void {
    for (const listener of this.statusListeners) listener(message);
  }

  private addStore(store: FileStore): void {
    this.stores.set(store.id, store);
  }

  private get workspace(): FileStore {
    const store = this.stores.get('workspace');
    if (!store) throw new Error('No workspace');
    return store;
  }

  private async addPcFolder(): Promise<FileStore | null> {
    const store = await pickFolder();
    if (store) this.addStore(store);
    return store;
  }

  private prompts(): Prompts {
    return {
      unsavedChanges: () =>
        this.dialogs.message(
          tr('Unsaved Changes'),
          tr('Save changes?'),
          [
            { label: tr('Save'), value: 'save' as const, primary: true },
            { label: tr('Discard'), value: 'discard' as const },
            { label: tr('Cancel'), value: 'cancel' as const },
          ],
          'cancel' as const,
        ),
      externalChange: (name, deleted, modified) => {
        if (deleted) {
          return this.dialogs.message(
            tr('File deleted by another program'),
            tr('{name} was deleted or moved outside the IDE after it was opened.', { name }),
            [
              { label: tr('Recreate the file'), value: 'overwrite' as const },
              { label: tr('Save a copy…'), value: 'copy' as const },
              { label: tr('Cancel'), value: null, primary: true },
            ],
            null,
            tr(
              'Recreate the file: saves it again where it was. Save a copy: saves the project in another file.',
            ),
          );
        }
        return this.dialogs.message(
          tr('File changed by another program'),
          tr(
            '{name} was changed outside the IDE after it was opened, for example by an MCP agent or from the command line. Saving now would lose those changes.',
            { name },
          ),
          [
            { label: tr('Reload'), value: 'reload' as const },
            { label: tr('Save a copy…'), value: 'copy' as const },
            { label: tr('Overwrite'), value: 'overwrite' as const },
            { label: tr('Cancel'), value: null, primary: true },
          ],
          null,
          modified
            ? tr(
                'Reload: opens the version on disk; the unsaved changes made here and the undo history are lost. Save a copy: keeps your changes in another file and leaves this one untouched. Overwrite: replaces the version on disk with yours.',
              )
            : tr(
                "Reload: opens the version on disk. Save a copy: keeps the IDE's version in another file. Overwrite: replaces the version on disk with the IDE's.",
              ),
        );
      },
      chooseSaveLocation: (suggested) => {
        // An example cannot be written: the suggestion moves to the workspace, same name.
        const target =
          suggested && !this.stores.get(suggested.store)?.readOnly
            ? suggested
            : { store: 'workspace', path: suggested ? baseName(suggested.path) : 'project.json' };
        return this.dialogs.choose({
          mode: 'save',
          title: tr('Save Project'),
          stores: [...this.stores.values()],
          suggested: target,
          accept: isProject,
          addFolder: canOpenFolders ? () => this.addPcFolder() : undefined,
        });
      },
      confirmReplace: (name) =>
        this.dialogs.message(
          tr('Save Project'),
          tr('{name} already exists. Replace it with this project?', { name }),
          [
            { label: tr('Yes'), value: true },
            { label: tr('No'), value: false, primary: true },
          ],
          false,
        ),
      error: (title, message) => void this.dialogs.notice(title, message),
      status: (message) => this.status(message),
    };
  }

  // ---- actions ----

  async openDialog(): Promise<void> {
    const location = await this.dialogs.choose({
      mode: 'open',
      title: tr('Open Project'),
      stores: [...this.stores.values()],
      suggested: this.session.location,
      accept: isProject,
      addFolder: canOpenFolders ? () => this.addPcFolder() : undefined,
    });
    if (location) await this.session.open(location);
  }

  async openPcFolder(): Promise<void> {
    const store = await this.addPcFolder();
    if (!store) return;
    const location = await this.dialogs.choose({
      mode: 'open',
      title: tr('Open Project'),
      stores: [...this.stores.values()],
      suggested: { store: store.id, path: '' },
      accept: isProject,
    });
    if (location) await this.session.open(location);
  }

  /** Files of the PC into the workspace: project files as they are, zips unpacked into a folder. */
  async importFiles(): Promise<void> {
    const files = await pickFiles('.json,.zip,application/json,application/zip');
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        if (file.name.toLowerCase().endsWith('.zip')) await this.importZip(file.name, data);
        else await this.importFile(file.name, data);
      } catch (error) {
        await this.dialogs.notice(
          tr('Import Error'),
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async importFile(name: string, data: Uint8Array): Promise<void> {
    const target = await this.dialogs.choose({
      mode: 'save',
      title: tr('Import into the Workspace'),
      stores: [...this.stores.values()],
      suggested: { store: 'workspace', path: name },
      acceptLabel: tr('Import'),
    });
    if (!target) return;
    const store = this.stores.get(target.store);
    if (!store) return;
    if ((await store.read(target.path)) !== null && !(await this.confirmReplaceFile(target)))
      return;
    await store.write(target.path, data);
    this.status(tr('Imported: {path}', { path: target.path }));
  }

  private async importZip(name: string, data: Uint8Array): Promise<void> {
    const files = readZip(data); // checked before asking anything
    const target = await this.dialogs.choose({
      mode: 'folder',
      title: tr('Import {name} into the folder', { name }),
      stores: [...this.stores.values()],
      suggested: { store: 'workspace', path: '' },
      acceptLabel: tr('Import'),
    });
    if (!target) return;
    const store = this.stores.get(target.store);
    if (!store) return;
    const existing = new Set(await walkFiles(store, target.path));
    const clashes = [...files.keys()].filter((path) => existing.has(joinPath(target.path, path)));
    if (clashes.length) {
      const replace = await this.dialogs.message(
        tr('Import'),
        tr('{count} files already exist in that folder. Replace them?', { count: clashes.length }),
        [
          { label: tr('Yes'), value: true },
          { label: tr('No'), value: false, primary: true },
        ],
        false,
        clashes.slice(0, 10).join('\n'),
      );
      if (!replace) return;
    }
    const written = await importZip(store, target.path, data);
    this.status(tr('Imported {count} files', { count: written.length }));
  }

  private confirmReplaceFile(target: Location): Promise<boolean> {
    return this.dialogs.message(
      tr('Import'),
      tr('{name} already exists. Replace it?', { name: baseName(target.path) }),
      [
        { label: tr('Yes'), value: true },
        { label: tr('No'), value: false, primary: true },
      ],
      false,
    );
  }

  /** The saved project file, as a download. */
  async exportProjectFile(): Promise<void> {
    const location = this.session.location;
    if (!location || this.session.modified) {
      await this.dialogs.notice(tr('Export Project File'), tr('Save the project first.'));
      return;
    }
    const data = await this.stores.get(location.store)?.read(location.path);
    if (data) download(baseName(location.path), data, 'application/json');
  }

  async exportFolderZip(): Promise<void> {
    const target = await this.dialogs.choose({
      mode: 'folder',
      title: tr('Export Folder as Zip'),
      stores: [...this.stores.values()],
      suggested: this.session.location
        ? { store: this.session.location.store, path: '' }
        : { store: 'workspace', path: '' },
      acceptLabel: tr('Export'),
    });
    if (!target) return;
    const store = this.stores.get(target.store);
    if (!store) return;
    const zip = await exportZip(store, target.path);
    const name = target.path
      ? baseName(target.path)
      : store.id === 'workspace'
        ? 'workspace'
        : 'files';
    download(`${name}.zip`, zip, 'application/zip');
  }

  async renamePageDialog(pageId: string): Promise<void> {
    const page = this.session.state?.pages.find((item) => item.id === pageId);
    if (!page) return;
    const name = await this.dialogs.askText(tr('Rename Page'), tr('Name:'), page.name);
    if (name !== null) await this.session.renamePage(pageId, name);
  }

  // ---- menus ----

  private async exampleItems(): Promise<MenuItem[]> {
    const examples = this.stores.get('examples');
    if (!examples) return [];
    const items: MenuItem[] = [];
    for (const entry of await examples.list('')) {
      const path =
        entry.kind === 'file'
          ? entry.name
          : (await examples.read(`${entry.name}/project.json`)) !== null
            ? `${entry.name}/project.json`
            : null;
      if (!path || !isProject(path)) continue;
      items.push({
        label: entry.kind === 'file' ? entry.name.replace(/\.json$/, '') : entry.name,
        id: `example:${path}`,
        action: () => void this.session.open({ store: 'examples', path }),
      });
    }
    return items;
  }

  private async boardItems(): Promise<MenuItem[]> {
    const profiles =
      await this.python.call<{ id: string; name: string; width: number; height: number }[]>(
        'profiles',
      );
    return profiles.map((profile) => ({
      label: `${profile.name} (${profile.width}×${profile.height})`,
      id: `board:${profile.id}`,
      action: () => void this.session.newProject(profile.id),
    }));
  }

  private recentItems(): MenuItem[] {
    return recentFiles(this.settings).map((location) => {
      const store = this.stores.get(location.store);
      return {
        label: `${store?.label ?? location.store}: ${location.path}`,
        disabled: !store,
        action: () => void this.session.open(location),
      };
    });
  }

  menus(): Menu[] {
    const session = this.session;
    const ready = session.state !== undefined;
    return [
      {
        label: tr('File'),
        items: () => [
          {
            label: tr('New'),
            id: 'new',
            disabled: !ready,
            action: () => void session.newProject(),
          },
          {
            label: tr('New for a Board'),
            id: 'new-board',
            disabled: !ready,
            items: () => this.boardItems(),
          },
          {
            label: tr('Open…'),
            id: 'open',
            shortcut: 'Ctrl+O',
            disabled: !ready,
            action: () => void this.openDialog(),
          },
          {
            label: tr('Open Example'),
            id: 'examples',
            disabled: !ready,
            items: () => this.exampleItems(),
          },
          ...(canOpenFolders
            ? [
                {
                  label: tr('Open a Folder of the PC…'),
                  id: 'pc-folder',
                  disabled: !ready,
                  action: () => void this.openPcFolder(),
                },
              ]
            : []),
          {
            label: tr('Save'),
            id: 'save',
            shortcut: 'Ctrl+S',
            disabled: !ready,
            action: () => void session.save(),
          },
          {
            label: tr('Save As…'),
            id: 'save-as',
            shortcut: 'Ctrl+Shift+S',
            disabled: !ready,
            action: () => void session.saveAs(),
          },
          { label: tr('Recent Files'), id: 'recent', items: () => this.recentItems() },
          { separator: true },
          {
            label: tr('Import into the Workspace…'),
            id: 'import',
            disabled: !ready,
            action: () => void this.importFiles(),
          },
          {
            label: tr('Export Project File'),
            id: 'export-file',
            disabled: !ready,
            action: () => void this.exportProjectFile(),
          },
          {
            label: tr('Export Folder as Zip…'),
            id: 'export-zip',
            disabled: !ready,
            action: () => void this.exportFolderZip(),
          },
        ],
      },
      {
        label: tr('Edit'),
        items: () => [
          {
            label: tr('Undo'),
            id: 'undo',
            shortcut: 'Ctrl+Z',
            disabled: !session.state?.canUndo,
            action: () => void session.undo(),
          },
          {
            label: tr('Redo'),
            id: 'redo',
            shortcut: 'Ctrl+Y',
            disabled: !session.state?.canRedo,
            action: () => void session.redo(),
          },
        ],
      },
      ...(this.run ? [this.runMenu(this.run, ready)] : []),
    ];
  }

  /** ui/main_window.py, the Run menu; the browser's own pages come in phase 7. */
  private runMenu(run: RunController, ready: boolean): Menu {
    return {
      label: tr('Run'),
      items: () => [
        {
          label: tr('Start'),
          id: 'run-start',
          shortcut: 'F5',
          disabled: !ready || run.running,
          action: () => void run.runProject(),
        },
        {
          label: tr('Stop'),
          id: 'run-stop',
          shortcut: 'Shift+F5',
          disabled: !run.running,
          action: () => void run.stop(),
        },
        {
          label: tr('Restart'),
          id: 'run-restart',
          disabled: !ready,
          action: () => void run.restart(),
        },
        { separator: true },
        {
          label: tr('Run Program…'),
          id: 'run-program',
          disabled: !ready || run.running,
          action: () => void run.runProgram(),
        },
        {
          label: tr('Erase Program Flash…'),
          id: 'erase-flash',
          disabled: !ready,
          action: () => void run.eraseProgramFlash(),
        },
      ],
    };
  }

  /**
   * Shortcuts the browser lets a page take. In the terminal of a program the keys are the
   * program's, Ctrl-C and Ctrl-Z included: only F5 and Shift+F5 stay the IDE's.
   */
  shortcut(event: KeyboardEvent, inTerminal = false): boolean {
    if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.metaKey && this.run) {
      if (event.shiftKey) void this.run.stop();
      else if (!this.run.running && this.session.state) void this.run.runProject();
      event.preventDefault();
      return true;
    }
    if (inTerminal) return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !this.session.state) return false;
    const key = event.key.toLowerCase();
    if (key === 's') void (event.shiftKey ? this.session.saveAs() : this.session.save());
    else if (key === 'o' && !event.shiftKey) void this.openDialog();
    else if (key === 'z' && !event.shiftKey) void this.session.undo();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) void this.session.redo();
    else return false;
    event.preventDefault();
    return true;
  }
}
