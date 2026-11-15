// The IDE's controller: the places where files live, the open project, the menus. The questions
// and their wording are the desktop's (ui/main_files.py).
import { tr } from '../i18n/tr.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { ProjectSession, type Prompts } from '../project/session.ts';
import { download, pickFiles } from '../storage/download.ts';
import { ExamplesStore } from '../storage/examples-store.ts';
import { canOpenFolders, pickFolder, savedFolders } from '../storage/folders.ts';
import { openConfig, openWorkspace } from '../storage/handle-store.ts';
import { ConfigSync, manageBlocks, manageProfiles } from './managers.ts';
import { BudgetMonitor, type BudgetText, type Limits } from './budget.ts';
import { FontConverter, GENERATING } from '../fonts/fonts.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import { recentFiles } from '../storage/recent.ts';
import type { Settings } from '../storage/settings.ts';
import {
  type FileStore,
  type Location,
  baseName,
  joinPath,
  parentPath,
  walkFiles,
} from '../storage/store.ts';
import { exportZip, importZip, readZip } from '../storage/zip.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import type { Menu, MenuItem } from '../ui/menu-bar.ts';
import type { TreeKey } from '../ui/project-tree.ts';
import type { DocState } from '../project/session.ts';
import { MpyCross } from '../mpy/mpy-cross.ts';
import { CodeController, type MappedError } from './code.ts';
import { DesignerController } from './designer.ts';
import { arrangeItems } from '../ui/designer-view.ts';
import { FileTabs } from './file-tabs.ts';
import { RunController, type RunView } from './run.ts';
import { DeviceController, type DeviceView } from './device.ts';
import { BOARD_STORE, BoardStore, boardPath } from '../board/board-store.ts';
import { skippedPath, uploadFilesDialog } from './upload-files.ts';

/** What the center shows: a page's canvas, the Code tab, the simulator, or a file tab by id. */
export type CenterTab = `page:${string}` | 'code' | 'simulator' | `file:${number}`;
const FILES_FOLDER = 'files/folder';

const isProject = (name: string) => name.toLowerCase().endsWith('.json');

export class Studio {
  readonly stores = new Map<string, FileStore>();
  readonly session: ProjectSession;
  /** Running in the simulator: set when the shell has its Simulator tab. */
  run: RunController | null = null;
  /** The board: set when the shell has its Device Console. */
  device: DeviceController | null = null;
  /** Set when the browser's private storage could not be opened: files live until a reload. */
  workspaceProblem: string | null = null;
  private readonly statusListeners = new Set<(message: string) => void>();
  private readonly workbenchListeners = new Set<() => void>();
  readonly mpyCross = new MpyCross();
  readonly files: FileTabs;
  readonly code: CodeController;
  /** The rows of the Errors panel. */
  errors: MappedError[] = [];
  /** The folder of the Files panel (QSettings files/folder). */
  filesFolder: Location | null = null;
  /** What the center shows; the shell follows it. Until a project is open, nothing yet. */
  tab: CenterTab = 'code';
  /** The page designer: set when the shell gives it where to draw previews. */
  designer: DesignerController | null = null;
  /** Where the Output panel writes; set by the shell. */
  output: (text: string) => void = () => {};
  private lvNames: Promise<string[]> | null = null;

  constructor(
    readonly python: PythonBridge,
    private readonly dialogs: Dialogs,
    private readonly settings: Settings,
  ) {
    // fontconv.py is Qt: the fonts of a project are converted here, before Python generates code
    const fonts = new FontConverter(python);
    python.before = (method) => (GENERATING.has(method) ? fonts.ensure() : Promise.resolve());
    this.session = new ProjectSession(python, this.stores, this.prompts(), settings);
    this.files = new FileTabs(
      this.stores,
      dialogs,
      python,
      this.mpyCross,
      (message) => this.status(message),
      (folder) => this.setFilesFolder(folder),
    );
    this.code = new CodeController(
      python,
      this.session,
      dialogs,
      this.mpyCross,
      (text) => this.output(text),
      (message) => this.status(message),
    );
    this.files.onChange(() => this.workbenchChanged());
    this.code.onChange(() => this.workbenchChanged());
    // the code as Python has it, after new, open, reload, undo and redo
    this.session.onChange(() => {
      this.scheduleBudget(); // the code counts too: MainWindow connects code_changed
      // an edit of the Code tab changes no page: design_key leaves the code out
      if (this.code.adopting) return;
      void this.code.refresh();
      this.pagesChanged();
    });
  }

  onWorkbench(listener: () => void): () => void {
    this.workbenchListeners.add(listener);
    return () => this.workbenchListeners.delete(listener);
  }

  private workbenchChanged(): void {
    for (const listener of this.workbenchListeners) listener();
  }

  show(tab: CenterTab): void {
    this.tab = tab;
    this.code.setActive(tab === 'code');
    this.designer?.setActive(this.currentPage());
    this.device?.scheduleLive(this.currentPage()); // tabs.currentChanged → _schedule_live
    this.workbenchChanged();
  }

  /** The page whose canvas is shown, or null. */
  currentPage(): string | null {
    return this.tab.startsWith('page:') ? this.tab.slice(5) : null;
  }

  /** _sync_designers: a tab per page; a page that went takes its tab with it. */
  private pagesChanged(): void {
    const pages = this.session.state?.pages ?? [];
    const current = this.currentPage();
    const first = pages[0];
    if (
      first &&
      (this.starting || (current !== null && !pages.some((page) => page.id === current)))
    ) {
      this.starting = false;
      this.show(`page:${first.id}`);
    }
    void this.designer?.refresh();
  }

  // ---- the project tree: ui/main_tree.py ----

  /** The tree's current item. */
  treeSelected: TreeKey | null = null;

  /** _tree_selection: a page shows its canvas; a widget is selected on it, a component in Properties. */
  treeSelect(key: TreeKey): void {
    this.treeSelected = key;
    const designer = this.designer;
    if (key.startsWith('page:')) {
      this.show(key as `page:${string}`);
    } else if (key.startsWith('widget:') && designer) {
      const name = key.slice(7);
      const widget = designer.tree.pages
        .flatMap((page) => page.widgets)
        .find((w) => w.name === name);
      const pageId = designer.pageOf(name);
      if (!widget || !pageId) return;
      if (widget.component) {
        designer.selectComponents([name]);
        return;
      }
      designer.select(pageId, [name]);
      this.show(`page:${pageId}`);
    }
    this.workbenchChanged();
  }

  /** _tree_activated: a widget's handler, a module's code. */
  treeActivate(key: TreeKey): void {
    if (key.startsWith('widget:')) void this.openHandler(key.slice(7));
    else if (key.startsWith('pymodule:')) {
      const module = this.session.state?.modules.find((item) => item.id === key.slice(9));
      if (module && this.code.openModule(module.name)) this.show('code');
    }
  }

  /** _project_menu: the module actions on the Python Modules branch, the page actions elsewhere. */
  treeMenu(key: TreeKey | null): MenuItem[] {
    if (key === 'modules' || key?.startsWith('pymodule:')) {
      const module = key.startsWith('pymodule:')
        ? this.session.state?.modules.find((item) => item.id === key.slice(9))
        : undefined;
      const items: MenuItem[] = [
        {
          label: tr('New Python Module…'),
          id: 'new-module',
          action: () => void this.code.newModule().then((done) => done && this.show('code')),
        },
      ];
      if (module) {
        items.push(
          { separator: true },
          { label: tr('Open Module'), id: 'open-module', action: () => this.treeActivate(key) },
          {
            label: tr('Rename Module…'),
            id: 'rename-module',
            action: () => {
              if (this.code.openModule(module.name)) void this.code.renameModule();
            },
          },
          {
            label: tr('Delete Module'),
            id: 'delete-module',
            action: () => {
              if (this.code.openModule(module.name)) void this.code.deleteModule();
            },
          },
        );
      }
      return items;
    }
    return this.pageItems();
  }

  /** The page actions of the Project menu and of the tree. */
  private pageItems(): MenuItem[] {
    const ready = this.session.state !== undefined;
    const locked = this.run?.running ?? false;
    return [
      {
        label: tr('Add Page'),
        id: 'add-page',
        disabled: !ready,
        action: () => void this.addPage(),
      },
      {
        label: tr('Rename Page'),
        id: 'rename-page',
        disabled: !ready || locked,
        action: () => {
          const page = this.selectedPage();
          if (page) void this.renamePageDialog(page);
        },
      },
      {
        label: tr('Delete Page'),
        id: 'delete-page',
        disabled: !ready,
        action: () => void this.deletePage(),
      },
      {
        label: tr('Set Initial Page'),
        id: 'initial-page',
        disabled: !ready,
        action: () => void this.setInitialPage(),
      },
    ];
  }

  /** _selected_page: the page selected in the tree, or the one shown, or the first. */
  selectedPage(): string | null {
    const key = this.treeSelected;
    const pages = this.session.state?.pages ?? [];
    if (key?.startsWith('page:') && pages.some((page) => `page:${page.id}` === key))
      return key.slice(5);
    return this.currentPage() ?? pages[0]?.id ?? null;
  }

  async addPage(): Promise<void> {
    this.session.adopt(await this.python.call<DocState>('doc_add_page'));
  }

  async deletePage(): Promise<void> {
    const page = this.selectedPage();
    if (!page) return;
    const result = await this.python.call<{ error: string | null; state: DocState }>(
      'doc_delete_page',
      page,
    );
    if (result.error) this.appendError(result.error);
    else this.session.adopt(result.state);
  }

  async setInitialPage(): Promise<void> {
    const page = this.selectedPage();
    if (page) this.session.adopt(await this.python.call<DocState>('doc_initial_page', page));
  }

  /** PropertiesPanel._event_activated: the handler made if missing, then open_handler. */
  async openEvent(widget: string, event: string): Promise<void> {
    const result = await this.python.call<{ handler: string; state: DocState }>(
      'event_handler',
      widget,
      event,
    );
    this.session.adopt(result.state);
    await this.code.refresh();
    await this.code.openObject(widget, event);
    this.show('code');
  }

  /** open_handler: the Code tab on the widget, at its default event; typing makes the handler. */
  async openHandler(name: string): Promise<void> {
    this.show('code');
    await this.code.openObject(name);
  }

  /** Upstream's configuration folder, kept in the browser. */
  config: ConfigSync | null = null;

  /** Device → Manage Board Profiles…. */
  async manageProfiles(): Promise<void> {
    if (this.config) await manageProfiles(this.python, this.dialogs, this.config);
  }

  /** Settings → Manage Blocks…: then MainWindow._blocks_changed, everything reads them again. */
  async manageBlocks(): Promise<void> {
    if (!this.config) return;
    const changed = await manageBlocks(this.python, this.dialogs, this.config, async () => {
      const chosen = await this.dialogs.choose({
        mode: 'folder',
        title: tr('Choose the folder of the block'),
        stores: [...this.stores.values()],
        readOnlyPlaces: true,
      });
      const store = chosen ? this.stores.get(chosen.store) : undefined;
      return chosen && store ? { store, path: chosen.path } : null;
    });
    if (changed) {
      this.designer?.blocksChanged();
      await this.code.refresh();
    }
  }

  /** The first project shows its first page, as the desktop opens on it. */
  private starting = true;

  /** The designer, with the element its previews run in, hidden. */
  attachDesigner(previewHost: HTMLElement): DesignerController {
    this.designer = new DesignerController(
      this.python,
      this.session,
      this.settings,
      this.dialogs,
      previewHost,
      (text) => this.output(text),
      (text) => this.appendError(text),
      // select_run_target and the resolution: not while a session runs, on the board either
      () =>
        (this.run?.running ?? false) ||
        (this.device?.appActive ?? false) ||
        (this.device?.busy ?? false),
    );
    this.designer.setActive(this.currentPage());
    void this.designer.refresh();
    // a host of its own: a simulator replaces what its container holds when it starts
    const budgetHost = document.createElement('div');
    previewHost.after(budgetHost);
    budgetHost.className = previewHost.className;
    this.budget = new BudgetMonitor(this.python, this.mpyCross, budgetHost);
    this.budget.onUpdate(() => void this.showBudget());
    this.budget.paused = () => this.run?.running ?? false;
    this.scheduleBudget();
    return this.designer;
  }

  // ---- the budget: MainWindow._schedule_budget and _show_budget ----

  budget: BudgetMonitor | null = null;
  budgetText: BudgetText | null = null;

  /** _board_limits: the free memory read from the board at the last connection (phase 6). */
  private boardLimits(): Limits {
    const board = this.session.state?.board;
    const saved = board ? this.settings.get<string>(`device/memory/${board}`, '') : '';
    try {
      return saved ? (JSON.parse(saved) as Limits) : {};
    } catch {
      return {};
    }
  }

  private scheduleBudget(): void {
    if (this.session.state) this.budget?.schedule(this.boardLimits());
  }

  private async showBudget(): Promise<void> {
    if (!this.budget) return;
    this.budgetText = await this.budget.text();
    this.workbenchChanged();
  }

  /** ui/main_run.py append_error: a line in Output and a row of Errors. */
  appendError(text: string): void {
    this.output(`${text}\n`);
    this.setErrors([...this.errors, { file: 'IDE', line: 0, message: text }]);
  }

  // ---- files: ui/main_editors.py, ui/files.py ----

  setFilesFolder(folder: Location | null): void {
    this.filesFolder = folder;
    this.settings.set(FILES_FOLDER, folder);
    this.workbenchChanged();
  }

  async openFile(location: Location): Promise<void> {
    const tab = await this.files.open(location);
    if (tab) this.show(`file:${tab.id}`);
  }

  async closeFile(id: number): Promise<boolean> {
    const tab = this.files.get(id);
    if (!tab || !(await this.files.close(tab))) return false;
    if (this.tab === `file:${id}`)
      this.show(
        this.files.tabs.at(-1) ? (`file:${this.files.tabs.at(-1)?.id}` as CenterTab) : 'code',
      );
    else this.workbenchChanged();
    return true;
  }

  /** The file of the current tab, if it is one. */
  currentFile() {
    return this.tab.startsWith('file:') ? this.files.get(Number(this.tab.slice(5))) : undefined;
  }

  currentPythonFile(): Location | null {
    const tab = this.currentFile();
    return tab && tab.location.path.endsWith('.py') ? tab.location : null;
  }

  /** Ctrl+S: the file of the current tab, or the project. */
  async saveCurrent(): Promise<boolean> {
    const tab = this.currentFile();
    return tab ? this.files.save(tab) : this.session.save();
  }

  /** CodePanel._entries: what completes a name in the Code tab. */
  codeEntries(qualified: string): Promise<(string | [string, string])[]> {
    return this.python.call<(string | [string, string])[]>('code_entries', qualified);
  }

  /** The names after lv., for completion. */
  lvCompletions(qualified: string): Promise<string[]> {
    if (!qualified.startsWith('lv.') || qualified.split('.').length !== 2)
      return Promise.resolve([]);
    this.lvNames ??= this.python.call<string[]>('lv_completions');
    return this.lvNames;
  }

  async chooseFilesFolder(): Promise<void> {
    const folder = await this.dialogs.choose({
      mode: 'folder',
      title: tr('Open Folder…'),
      stores: [...this.stores.values()],
      suggested: this.filesFolder ?? { store: 'workspace', path: '' },
      readOnlyPlaces: true,
      addFolder: canOpenFolders ? () => this.addPcFolder() : undefined,
    });
    if (folder) this.setFilesFolder(folder);
  }

  private async askName(title: string, text = ''): Promise<string | null> {
    const answer = await this.dialogs.askText(title, tr('Name:'), text);
    const name = (answer ?? '').trim();
    if (answer === null || !name) return null;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      await this.dialogs.notice(title, tr('A name without / or \\, please.'));
      return null;
    }
    return name;
  }

  async newFile(folder: Location): Promise<void> {
    const name = await this.askName(tr('New File…'), 'main.py');
    if (name === null) return;
    const store = this.stores.get(folder.store);
    const path = joinPath(folder.path, name);
    if (!store) return;
    if ((await store.read(path)) !== null) {
      await this.dialogs.notice(tr('New File…'), tr('{name} already exists.', { name }));
      return;
    }
    await store.write(path, new Uint8Array());
    this.workbenchChanged();
    await this.openFile({ store: folder.store, path });
  }

  async newFolder(folder: Location): Promise<void> {
    const name = await this.askName(tr('New Folder…'));
    const store = this.stores.get(folder.store);
    if (name === null || !store) return;
    try {
      await store.makeFolder(joinPath(folder.path, name));
    } catch (error) {
      await this.dialogs.notice(
        tr('New Folder…'),
        error instanceof Error ? error.message : String(error),
      );
    }
    this.workbenchChanged();
  }

  async renameEntry(location: Location, kind: 'file' | 'folder'): Promise<void> {
    const old = baseName(location.path);
    const name = await this.askName(tr('Rename…'), old);
    const store = this.stores.get(location.store);
    if (name === null || name === old || !store) return;
    const parent = location.path.slice(0, location.path.length - old.length).replace(/\/$/, '');
    const target = joinPath(parent, name);
    const exists =
      (await store.read(target)) !== null ||
      (await walkFiles(store, parent)).some((p) => p.startsWith(`${target}/`));
    if (exists) {
      await this.dialogs.notice(tr('Rename…'), tr('{name} already exists.', { name }));
      return;
    }
    // A store has no rename: the files are copied, then the old ones removed.
    const files = kind === 'file' ? [location.path] : await walkFiles(store, location.path);
    for (const path of files) {
      const data = await store.read(path);
      if (data) await store.write(target + path.slice(location.path.length), data);
    }
    if (kind === 'folder' && !files.length) await store.makeFolder(target);
    await store.remove(location.path);
    for (const tab of this.files.tabs) {
      if (tab.location.store !== location.store) continue;
      if (
        tab.location.path === location.path ||
        tab.location.path.startsWith(`${location.path}/`)
      ) {
        tab.location = {
          store: location.store,
          path: target + tab.location.path.slice(location.path.length),
        };
      }
    }
    this.workbenchChanged();
  }

  async deleteEntry(location: Location, kind: 'file' | 'folder'): Promise<void> {
    const store = this.stores.get(location.store);
    if (!store) return;
    const yes = await this.dialogs.message(
      tr('Delete…'),
      kind === 'folder'
        ? tr('Delete the folder {name} with everything in it?', { name: location.path })
        : tr('Delete {name}?', { name: location.path }),
      [
        { label: tr('Yes'), value: true },
        { label: tr('No'), value: false, primary: true },
      ],
      false,
    );
    if (!yes) return;
    await store.remove(location.path);
    this.workbenchChanged();
  }

  /** Grows when the board's side of the Files panel must be read again. */
  boardRevision = 0;
  /** The entry selected in the board's view, for current_folder. */
  private boardSelection: { path: string; kind: 'file' | 'folder' } | null = null;

  selectBoardEntry(path: string, kind: 'file' | 'folder'): void {
    this.boardSelection = { path, kind };
  }

  /** BoardFilesView.current_folder: the folder selected, or the folder of the file; "/" without. */
  boardCurrentFolder(): string {
    const entry = this.boardSelection;
    if (!entry || !this.device?.connected) return '/';
    return boardPath(entry.kind === 'folder' ? entry.path : parentPath(entry.path));
  }

  /** The board's folder of an entry: itself, or the folder of a file (current_folder). */
  private boardFolder(entry: { location: Location; kind: 'file' | 'folder' } | null): string {
    if (!entry) return '';
    return entry.kind === 'folder' ? entry.location.path : parentPath(entry.location.path);
  }

  /** download_board_file: into the Files panel's folder, as the desktop does; else a download. */
  private async downloadBoardFile(path: string): Promise<void> {
    const store = this.stores.get(BOARD_STORE);
    const data = await store?.read(path);
    if (!data) return;
    const name = baseName(path);
    const folder = this.filesFolder;
    const target = folder ? this.stores.get(folder.store) : undefined;
    if (!folder || !target || target.readOnly) {
      download(name, data);
      return;
    }
    const local = joinPath(folder.path, name);
    if ((await target.read(local)) !== null) {
      const yes = await this.dialogs.message(
        tr('Download to the Computer'),
        tr('{path} exists. Replace it?', { path: local }),
        [
          { label: tr('Yes'), value: true },
          { label: tr('No'), value: false, primary: true },
        ],
        false,
      );
      if (!yes) return;
    }
    await target.write(local, data);
    this.status(tr('Downloaded to {path}', { path: local }));
    this.workbenchChanged();
  }

  private async boardNewFolder(folder: string): Promise<void> {
    const name = await this.askName(tr('New Folder…'));
    if (name === null) return;
    await this.stores.get(BOARD_STORE)?.makeFolder(joinPath(folder, name));
    this.boardRevision++;
    this.workbenchChanged();
  }

  private async boardRename(path: string): Promise<void> {
    const old = baseName(path);
    const name = await this.askName(tr('Rename…'), old);
    if (name === null || name === old) return;
    const target = joinPath(parentPath(path), name);
    await (this.stores.get(BOARD_STORE) as BoardStore | undefined)?.rename(path, target);
    for (const tab of this.files.tabs) {
      if (tab.location.store === BOARD_STORE && tab.location.path === path) {
        tab.location = { store: BOARD_STORE, path: target };
      }
    }
    this.boardRevision++;
    this.workbenchChanged();
  }

  private async boardDelete(path: string, folder: boolean): Promise<void> {
    const remote = boardPath(path);
    const yes = await this.dialogs.message(
      tr('Delete…'),
      folder
        ? tr('Delete the folder {path} from the board, with everything in it?', { path: remote })
        : tr('Delete {path} from the board?', { path: remote }),
      [
        { label: tr('Yes'), value: true },
        { label: tr('No'), value: false, primary: true },
      ],
      false,
    );
    if (!yes) return;
    await this.stores.get(BOARD_STORE)?.remove(path);
    this.boardRevision++;
    this.workbenchChanged();
  }

  /** BoardFilesView._menu: what can be done with a file or a folder of the board. */
  boardFilesMenu(entry: { location: Location; kind: 'file' | 'folder' } | null): MenuItem[] {
    const device = this.device;
    if (!device?.connected) return [];
    const items: MenuItem[] = [];
    if (entry?.kind === 'file') {
      items.push(
        {
          label: tr('Open'),
          id: 'board-open',
          action: () => void this.openFile(entry.location),
        },
        ...(entry.location.path.endsWith('.py')
          ? [
              {
                label: tr('Run on the Board'),
                id: 'board-run',
                action: () => void device.runFileOnBoard(boardPath(entry.location.path)),
              },
            ]
          : []),
        {
          label: tr('Download to the Computer'),
          id: 'board-download',
          action: () => void this.downloadBoardFile(entry.location.path),
        },
        { separator: true },
      );
    }
    const folder = this.boardFolder(entry);
    items.push({
      label: tr('Upload Files Here…'),
      id: 'board-upload-here',
      action: () => void this.uploadFiles(boardPath(folder)),
    });
    items.push({
      label: tr('New Folder…'),
      id: 'board-new-folder',
      action: () => void this.boardNewFolder(folder),
    });
    if (entry) {
      items.push(
        {
          label: tr('Rename…'),
          id: 'board-rename',
          action: () => void this.boardRename(entry.location.path),
        },
        {
          label: tr('Delete…'),
          id: 'board-delete',
          action: () => void this.boardDelete(entry.location.path, entry.kind === 'folder'),
        },
      );
    }
    items.push(
      { separator: true },
      {
        label: tr('Refresh'),
        id: 'board-refresh',
        action: () => this.refreshBoardFiles(),
      },
    );
    return items;
  }

  refreshBoardFiles(): void {
    this.boardRevision++;
    this.workbenchChanged();
  }

  /** The context menu of the Files panel, as FilesPanel._menu. */
  filesMenu(entry: { location: Location; kind: 'file' | 'folder' } | null): MenuItem[] {
    const folder = this.filesFolder;
    if (!folder) return [];
    const store = this.stores.get(folder.store);
    const readOnly = store?.readOnly ?? true;
    const items: MenuItem[] = [];
    if (entry?.kind === 'file') {
      items.push({
        label: tr('Open'),
        id: 'files-open',
        action: () => void this.openFile(entry.location),
      });
      if (entry.location.path.endsWith('.py')) {
        items.push(
          {
            label: tr('Run Program'),
            id: 'files-run',
            disabled: !this.run || this.run.running,
            action: () => void this.run?.runProgram(entry.location),
          },
          {
            label: tr('Run on the Board'),
            id: 'files-run-board',
            disabled: !this.device?.available || this.device.busy,
            action: () => void this.runProgramOnBoard(entry.location),
          },
        );
      }
    }
    if (entry && this.device?.connected) {
      const location = entry.location;
      items.push({
        label: tr('Upload to {folder} on the Board', { folder: this.boardCurrentFolder() }),
        id: 'files-upload-board',
        disabled: this.device.busy,
        action: () =>
          void (async () => {
            const store = this.stores.get(location.store);
            const items =
              entry.kind === 'folder'
                ? await this.folderItems(location)
                : [
                    {
                      name: baseName(location.path),
                      read: async () => (await store?.read(location.path)) ?? new Uint8Array(),
                    },
                  ];
            await this.device?.uploadFiles(items, this.boardCurrentFolder());
          })(),
      });
    }
    if (entry) items.push({ separator: true });
    const target = !entry
      ? folder
      : entry.kind === 'folder'
        ? entry.location
        : { store: folder.store, path: entry.location.path.split('/').slice(0, -1).join('/') };
    items.push(
      {
        label: tr('New File…'),
        id: 'files-new-file',
        disabled: readOnly,
        action: () => void this.newFile(target),
      },
      {
        label: tr('New Folder…'),
        id: 'files-new-folder',
        disabled: readOnly,
        action: () => void this.newFolder(target),
      },
    );
    if (entry) {
      items.push(
        {
          label: tr('Rename…'),
          id: 'files-rename',
          disabled: readOnly,
          action: () => void this.renameEntry(entry.location, entry.kind),
        },
        {
          label: tr('Delete…'),
          id: 'files-delete',
          disabled: readOnly,
          action: () => void this.deleteEntry(entry.location, entry.kind),
        },
      );
    }
    return items;
  }

  // ---- errors ----

  setErrors(rows: MappedError[]): void {
    this.errors = rows;
    this.workbenchChanged();
  }

  /** RunMixin._error_activated: the line in the module or the handler. */
  async openError(error: MappedError): Promise<number | null> {
    const line = error.sourceLine ?? error.line ?? 1;
    const code = this.code;
    if (error.module) {
      const module = code.state.modules.find((m) => m.name === error.module);
      if (!module) return null;
      await code.select({ kind: 'pymodule', id: module.id });
    } else if (error.handler) {
      if (error.handler === 'module') await code.select({ kind: 'module' });
      else if (code.state.handlers.some((h) => h.name === error.handler))
        await code.select({ kind: 'handler', name: error.handler });
      else return null;
    } else {
      return null;
    }
    this.show('code');
    return line;
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
    const saved = this.settings.get<Location | null>(FILES_FOLDER, null);
    if (saved && this.stores.has(saved.store)) this.filesFolder = saved;
    let config: FileStore;
    try {
      config = await openConfig();
    } catch {
      config = new MemoryStore('config', 'Configuration');
    }
    this.config = new ConfigSync(this.python, config);
    await this.python.ready;
    try {
      await this.config.load(); // the user's profiles and blocks, before the first project
    } catch (error) {
      this.output(`${error instanceof Error ? error.message : String(error)}\n`);
    }
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
        hooks: {
          compile: (directory, files) => this.code.compileDirectory(directory, files),
          traceErrors: (text) => this.python.call<MappedError[]>('code_trace_errors', text),
          setErrors: (rows) => this.setErrors(rows),
          addErrors: (rows) => this.setErrors([...this.errors, ...rows]),
          saveFilesIn: (folder) => this.files.saveFilesIn(folder),
          currentPythonFile: () => this.currentPythonFile(),
        },
      },
      screen,
    );
    return this.run;
  }

  /** The Device Console and the upload's progress of the shell. */
  attachDevice(view: DeviceView): DeviceController {
    this.device = new DeviceController(this.python, this.session, this.settings, view, {
      appendError: (text) => this.appendError(text),
      addErrors: (rows) => this.setErrors([...this.errors, ...rows]),
      showWarnings: (warnings) => {
        for (const warning of warnings) this.output(`${tr('Warning: {warning}', { warning })}\n`);
      },
      saveProject: () => this.session.save(),
      boardMemory: () => this.scheduleBudget(),
      ask: (title, text) =>
        this.dialogs.message(
          title,
          text,
          [
            { label: tr('Yes'), value: true, primary: true },
            { label: tr('No'), value: false },
          ],
          false,
        ),
      askText: (title, label, value) => this.dialogs.askText(title, label, value),
      reloadBoardFolder: () => this.refreshBoardFiles(),
      saveConfig: () => this.config?.save() ?? Promise.resolve(),
    });
    const device = this.device;
    let connected = false;
    device.onChange(() => {
      if (device.connected !== connected) {
        connected = device.connected;
        this.boardRevision++; // the board's view is read again, or emptied
        this.boardSelection = null;
      }
      this.workbenchChanged();
    });
    this.addStore(new BoardStore(device));
    return device;
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
            action: () => void this.saveCurrent(),
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
          { separator: true },
          ...this.editItems(),
          { separator: true },
          {
            label: tr('Select All'),
            id: 'select-all',
            shortcut: 'Ctrl+A',
            disabled: !this.currentPage(),
            action: () => this.designer?.selectAll(),
          },
        ],
      },
      ...(this.designer ? [this.arrangeMenu(this.designer)] : []),
      ...(this.run ? [this.runMenu(this.run, ready)] : []),
      {
        label: tr('Project'),
        items: () => [
          ...this.pageItems(),
          { separator: true },
          {
            label: tr('Project Settings…'),
            id: 'project-settings',
            disabled: !ready || !this.designer,
            action: () => void this.designer?.projectSettings(),
          },
          {
            label: tr('Update Project Profile'),
            id: 'update-profile',
            disabled: !ready || !this.session.state?.board,
            action: () => void this.designer?.updateProjectProfile(),
          },
        ],
      },
      {
        label: tr('Device'),
        items: () => [
          ...(this.device ? this.deviceItems(this.device, ready) : []),
          {
            label: tr('Manage Board Profiles…'),
            id: 'profiles',
            disabled: !ready,
            action: () => void this.manageProfiles(),
          },
        ],
      },
      ...(this.designer && this.device ? [this.runOnMenu(this.designer, this.device, ready)] : []),
      {
        label: tr('Settings'),
        items: () => [
          {
            label: tr('Manage Blocks…'),
            id: 'blocks',
            disabled: !ready,
            action: () => void this.manageBlocks(),
          },
        ],
      },
      ...(this.designer ? [this.viewMenu(this.designer)] : []),
    ];
  }

  /** Cut, Copy, Paste, Duplicate, Delete: on the canvas shown. */
  private editItems(): MenuItem[] {
    const designer = this.designer;
    const page = this.currentPage();
    const none = !designer || !page || !designer.selected(page).length;
    const item = (
      label: string,
      id: string,
      shortcut: string,
      action: (d: DesignerController) => Promise<void>,
      disabled: boolean,
    ): MenuItem => ({
      label: tr(label),
      id,
      shortcut,
      disabled,
      action: () => designer && void action(designer),
    });
    return [
      item('Cut', 'cut', 'Ctrl+X', (d) => d.copy(true), none),
      item('Copy', 'copy', 'Ctrl+C', (d) => d.copy(false), none),
      item('Paste', 'paste', 'Ctrl+V', (d) => d.paste(), !designer || !page),
      item('Duplicate', 'duplicate', 'Ctrl+D', (d) => d.duplicate(), none),
      item('Delete', 'delete', 'Del', (d) => d.deleteSelected(), none),
    ];
  }

  /** ui/main_window.py, the Arrange menu. */
  private arrangeMenu(designer: DesignerController): Menu {
    return {
      label: tr('Arrange'),
      items: () => {
        const page = this.currentPage();
        const designSize = page ? designer.pages.get(page)?.designSize : null;
        return [
          ...arrangeItems(designer, page),
          { separator: true },
          {
            label: tr('Adapt Page to Resolution…'),
            id: 'adapt-page',
            disabled: !designSize,
            action: () => void designer.adaptPage(this.selectedPage()),
          },
        ];
      },
    };
  }

  /** ui/main_window.py, the View menu's designer actions. */
  private viewMenu(designer: DesignerController): Menu {
    const page = this.currentPage();
    return {
      label: tr('View'),
      items: () => [
        {
          label: tr('Grid'),
          id: 'grid',
          checked: designer.grid,
          action: () => designer.toggleGrid(),
        },
        {
          label: tr('Real LVGL Preview'),
          id: 'preview',
          checked: designer.previewOn,
          action: () => designer.togglePreview(),
        },
        {
          label: tr('Zoom In'),
          id: 'zoom-in',
          shortcut: 'Ctrl++',
          disabled: !page,
          action: () => designer.zoom(1.25),
        },
        {
          label: tr('Zoom Out'),
          id: 'zoom-out',
          shortcut: 'Ctrl+-',
          disabled: !page,
          action: () => designer.zoom(0.8),
        },
        {
          label: tr('Fit to Window'),
          id: 'fit',
          shortcut: 'Ctrl+0',
          disabled: !page,
          action: () => designer.fit(),
        },
      ],
    };
  }

  /** The board profiles for the run target selector, read when it opens. */
  private runProfiles: { id: string; name: string }[] = [];

  /** _board_entries: the profiles, and the project's own board if the store lacks it. */
  private async loadRunProfiles(): Promise<void> {
    const profiles = await this.python.call<{ id: string; name: string }[]>('profiles');
    const board = this.session.state?.board;
    if (board && !profiles.some((p) => p.id === board))
      profiles.unshift({ id: board, name: board });
    const changed = JSON.stringify(profiles) !== JSON.stringify(this.runProfiles);
    this.runProfiles = profiles;
    if (changed) this.workbenchChanged();
  }

  /** The label of a board in the selector: its name and port (RunTargetSelector). */
  private boardLabel(profile: { id: string; name: string }): string {
    const device = this.device;
    const port =
      device?.connected && device.profileId === profile.id
        ? device.port?.label
        : this.settings.get<string>(`device/ports/${profile.id}`, '')
          ? `USB ${this.settings.get<string>(`device/ports/${profile.id}`, '')}`
          : '';
    return `${profile.name} · ${port || tr('no port')}`;
  }

  /** ui/run_target.py RunTargetSelector: where to run, the board's port, the defaults. */
  private runOnMenu(designer: DesignerController, device: DeviceController, ready: boolean): Menu {
    const state = this.session.state;
    if (!this.runProfiles.length && ready) void this.loadRunProfiles();
    const board = state?.board;
    const current =
      board && this.onBoard
        ? (this.runProfiles.find((p) => p.id === board) ?? { id: board, name: board })
        : null;
    const label = current ? this.boardLabel(current) : tr('Simulator');
    return {
      label,
      title: tr('Run on: {target}', { target: label }),
      onOpen: () => this.loadRunProfiles(),
      items: () => [
        {
          label: tr('Simulator'),
          id: 'target-simulator',
          checked: !this.onBoard,
          disabled: !ready,
          action: () => void designer.selectRunTarget('simulator'),
        },
        { section: tr('Board') },
        ...this.runProfiles.map((profile): MenuItem => ({
          label: this.boardLabel(profile),
          id: `target-${profile.id}`,
          checked: this.onBoard && this.session.state?.board === profile.id,
          disabled: !ready,
          action: () => void designer.selectRunTarget('board', profile.id),
        })),
        { separator: true },
        {
          label: tr('Change Port…'),
          id: 'target-port',
          disabled: !this.onBoard || device.busy || !device.available,
          action: () => void device.changePort(),
        },
        {
          label: tr('Manage Board Profiles…'),
          id: 'target-profiles',
          disabled: !ready,
          action: () => void this.manageProfiles(),
        },
        { separator: true },
        {
          label: tr('Use as default for new projects'),
          id: 'target-default',
          disabled: !ready,
          action: () => void this.saveNewProjectDefaults(label),
        },
        {
          label: tr('Remove default'),
          id: 'target-no-default',
          disabled: !this.settings.get<string>('defaults/newProject', ''),
          action: () => {
            this.settings.remove('defaults/newProject');
            this.status(tr('Default removed'));
          },
        },
      ],
    };
  }

  /** save_new_project_defaults: the setting the desktop keeps, the same JSON. */
  private async saveNewProjectDefaults(label: string): Promise<void> {
    const defaults = await this.python.call<unknown>('new_project_defaults');
    this.settings.set('defaults/newProject', JSON.stringify(defaults));
    this.status(tr('Default for new projects: {target}', { target: label }));
  }

  /** ui/main_window.py, the Device menu, enabled as _update_device_actions says. */
  private deviceItems(device: DeviceController, ready: boolean): MenuItem[] {
    const board = ready && this.onBoard && device.available;
    const busy = device.busy;
    const connected = device.connected;
    const notice: MenuItem[] = device.available
      ? []
      : [
          {
            label: tr('This browser has no Web Serial: the board works in Chrome or Edge'),
            id: 'device-unavailable',
            disabled: true,
            action: () => {},
          },
          { separator: true },
        ];
    return [
      ...notice,
      {
        label: tr('Change Port…'),
        id: 'device-port',
        disabled: busy || !board,
        action: () => void device.changePort(),
      },
      {
        label: connected ? tr('Disconnect') : tr('Connect'),
        id: 'device-connect',
        disabled: busy || !(connected || board),
        action: () => void device.connectDisconnect(),
      },
      {
        label: tr('Device Information'),
        id: 'device-info',
        disabled: busy || !connected,
        action: () => device.showInfo(),
      },
      { separator: true },
      {
        label: tr('Live Editing'),
        id: 'device-live',
        checked: device.liveOn,
        action: () => device.toggleLive(!device.liveOn),
      },
      {
        label: tr('Upload Project'),
        id: 'device-upload',
        disabled: busy || !board,
        action: () => void device.upload(false),
      },
      {
        label: tr('Upload and Run'),
        id: 'device-upload-run',
        disabled: busy || !board,
        action: () => void device.upload(true),
      },
      {
        label: tr('Stop'),
        id: 'device-stop',
        disabled: busy || !connected || !device.appActive,
        action: () => device.stop(),
      },
      {
        label: tr('Restart Interpreter'),
        id: 'device-restart',
        disabled: busy || !connected,
        action: () => device.restart(),
      },
      { separator: true },
      {
        label: tr('Upload Files…'),
        id: 'device-upload-files',
        disabled: busy || !board,
        action: () => void this.uploadFiles(),
      },
      {
        label: tr('Run File on Board…'),
        id: 'device-run-file',
        disabled: busy || !board,
        action: () => void device.runFileOnBoard(),
      },
      { separator: true },
      {
        label: tr('Install Autostart…'),
        id: 'device-autostart-install',
        disabled: busy || !connected,
        action: () => void device.installAutostart(),
      },
      {
        label: tr('Remove Autostart…'),
        id: 'device-autostart-remove',
        disabled: busy || !connected,
        action: () => void device.removeAutostart(),
      },
      { separator: true },
    ];
  }

  /** upload_files: the dialog, then the questions and the upload. */
  private async uploadFiles(folder?: string): Promise<void> {
    const device = this.device;
    if (!device) return;
    if (folder !== undefined) {
      // Upload Files Here…: files of the PC to that folder of the board
      const files = await pickFiles('');
      if (!files.length) return;
      const items = files.map((file) => ({
        name: file.name,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      }));
      await device.uploadFiles(items, folder);
      return;
    }
    const choice = await uploadFilesDialog(this.dialogs, this.settings);
    if (choice) await device.uploadFiles(choice.items, choice.destination, choice.compile);
  }

  /** The files of a folder of a place, named from the folder's parent: the folder itself goes. */
  private async folderItems(
    folder: Location,
  ): Promise<{ name: string; read: () => Promise<Uint8Array> }[]> {
    const store = this.stores.get(folder.store);
    if (!store) return [];
    const top = folder.path ? baseName(folder.path) : store.id;
    const items = [];
    for (const path of await walkFiles(store, folder.path)) {
      const name = `${top}/${folder.path ? path.slice(folder.path.length + 1) : path}`;
      if (skippedPath(name)) continue;
      items.push({
        name,
        read: async () => (await store.read(path)) ?? new Uint8Array(),
      });
    }
    return items;
  }

  /** run_program_on_board: as Run Program, on the board: its folder is uploaded, then it runs. */
  async runProgramOnBoard(entry?: Location): Promise<boolean> {
    const device = this.device;
    if (!device) return false;
    if (!entry) {
      const chosen = await this.dialogs.choose({
        mode: 'open',
        title: tr('Run on the Board'),
        stores: [...this.stores.values()],
        suggested: this.currentPythonFile() ?? this.run?.lastProgram() ?? null,
        accept: (name) => name.toLowerCase().endsWith('.py'),
      });
      if (!chosen) return false;
      entry = chosen;
      this.settings.set('simulator/program', chosen);
      this.setFilesFolder({ store: chosen.store, path: parentPath(chosen.path) });
    }
    const folder = { store: entry.store, path: parentPath(entry.path) };
    if (!(await this.files.saveFilesIn(folder))) return false;
    // view.current_folder() if a folder of the board is selected, else the program root
    const destination =
      this.boardSelection && device.connected
        ? this.boardCurrentFolder()
        : await device.programRoot();
    const items = await this.folderItems(folder);
    const top = items[0]?.name.split('/')[0] ?? '';
    const name = baseName(entry.path);
    const remote = `${destination.replace(/\/$/, '')}/${top}/${folder.path ? entry.path.slice(folder.path.length + 1) : entry.path}`;
    this.status(
      tr('Uploading {folder} to {destination} on the board, then running {name}…', {
        folder: top,
        destination,
        name,
      }),
    );
    return device.uploadFiles(items, destination, false, () => void device.runFileOnBoard(remote));
  }

  /** MainWindow.run_target: the board only when the project runs on its board profile. */
  get onBoard(): boolean {
    return this.session.state?.runTarget === 'board';
  }

  /** run_project: on the board, Upload and Run; otherwise the simulator. */
  startProject(): void {
    if (this.onBoard) void this.device?.upload(true);
    else if (this.run && !this.run.running && this.session.state) void this.run.runProject();
  }

  /** stop_simulation: on the board, its Stop. */
  stopProject(): void {
    if (this.onBoard) this.device?.stop();
    else void this.run?.stop();
  }

  /** _update_device_actions for Start and Stop. */
  private startStopDisabled(run: RunController): { start: boolean; stop: boolean } {
    const device = this.device;
    const busy = device?.busy ?? false;
    if (this.onBoard) {
      return {
        start: busy || run.running || !device?.available,
        stop: busy || !device?.connected || !device.appActive,
      };
    }
    return { start: busy || run.running, stop: busy || !run.running };
  }

  private runMenu(run: RunController, ready: boolean): Menu {
    return {
      label: tr('Run'),
      items: () => [
        {
          label: tr('Start'),
          id: 'run-start',
          shortcut: 'F5',
          disabled: !ready || this.startStopDisabled(run).start,
          action: () => this.startProject(),
        },
        {
          label: tr('Stop'),
          id: 'run-stop',
          shortcut: 'Shift+F5',
          disabled: this.startStopDisabled(run).stop,
          action: () => this.stopProject(),
        },
        {
          label: tr('Restart'),
          id: 'run-restart',
          disabled: !ready || this.onBoard || (this.device?.busy ?? false),
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
          label: tr('Run on the Board…'),
          id: 'run-board-program',
          disabled: !ready || !this.device?.available || (this.device?.busy ?? false),
          action: () => void this.runProgramOnBoard(),
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
  shortcut(event: KeyboardEvent, inTerminal = false, inEditor = false): boolean {
    if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.metaKey && this.run) {
      const { start, stop } = this.startStopDisabled(this.run);
      if (event.shiftKey) {
        if (!stop) this.stopProject();
      } else if (!start) {
        this.startProject();
      }
      event.preventDefault();
      return true;
    }
    if (inTerminal) return false;
    if (event.key === 'Escape' && this.designer?.armed) {
      this.designer.arm(null);
      return true;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !this.session.state) return false;
    const key = event.key.toLowerCase();
    // QKeySequence.ZoomIn, ZoomOut and Fit to Window, while a page is shown
    // the Edit actions on the canvas shown; in a text field they are the field's
    const designer = this.designer;
    if (designer && this.currentPage() && !inEditor && !event.shiftKey) {
      const actions: Record<string, () => Promise<void>> = {
        x: () => designer.copy(true),
        c: () => designer.copy(false),
        v: () => designer.paste(),
        d: () => designer.duplicate(),
        ']': () => designer.changeZ(true),
        '[': () => designer.changeZ(false),
      };
      const action = actions[key];
      if (action) {
        void action();
        event.preventDefault();
        return true;
      }
    }
    if (this.designer && this.currentPage() && !inEditor && key === 'a' && !event.shiftKey) {
      this.designer.selectAll();
      event.preventDefault();
      return true;
    }
    if (this.designer && this.currentPage() && !inEditor && ['+', '=', '-', '0'].includes(key)) {
      if (key === '0') this.designer.fit();
      else this.designer.zoom(key === '-' ? 0.8 : 1.25);
      event.preventDefault();
      return true;
    }
    if (key === 's') void (event.shiftKey ? this.session.saveAs() : this.saveCurrent());
    else if (key === 'o' && !event.shiftKey) void this.openDialog();
    // in an editor, undo and redo are the editor's, as in the desktop's text widgets
    else if (key === 'z' && !event.shiftKey && !inEditor) void this.session.undo();
    else if ((key === 'y' || (key === 'z' && event.shiftKey)) && !inEditor)
      void this.session.redo();
    else return false;
    event.preventDefault();
    return true;
  }
}
