// Run in the simulator, as upstream's ui/main_run.py (RunMixin): a project with pages, or a
// program without pages with a flash of its own that is kept between runs, as a board keeps its
// files. What runs is upstream's: the generated project, and runtime/program for a program.
import { tr } from '../i18n/tr.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { pythonPath } from '../project/session.ts';
import type { ProjectSession } from '../project/session.ts';
import { HandleStore } from '../storage/handle-store.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import type { Settings } from '../storage/settings.ts';
import {
  type FileStore,
  type Location,
  baseName,
  parentPath,
  walkFiles,
} from '../storage/store.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import type { MappedError } from './code.ts';
import {
  type FlashChange,
  type SimFile,
  type SimState,
  type SimStart,
  Simulator,
} from '../sim/simulator.ts';

/** QSettings "simulator/program": the last program run, as a place and a path. */
const LAST_PROGRAM = 'simulator/program';
const PYTHON_FLASH = '/sim/flash';
// build/program.py SKIPPED: folders that never go to the flash. Checked here too, so that a
// node_modules does not travel into Python before upstream leaves it out.
const SKIPPED = new Set(['__pycache__', '.git', '.hg', '.svn', '.venv', 'node_modules']);

export interface RunView {
  /** The Output panel: what the IDE says, and what a project prints. */
  output(text: string): void;
  /** The terminal of a program: its serial port. */
  terminal(text: string): void;
  clearTerminal(): void;
  focusTerminal(): void;
  state(state: SimState, program: boolean): void;
  status(message: string): void;
}

/** What a run needs from the rest of the IDE: the editors, mpy-cross, the Errors panel. */
export interface RunHooks {
  /** compile_python on the generated files: mapped errors, empty when all compiled. */
  compile(directory: string, files: string[]): Promise<MappedError[]>;
  /** The rows of the Errors panel for a complete traceback (ui/main_run.py _sim_output). */
  traceErrors(text: string): Promise<MappedError[]>;
  setErrors(rows: MappedError[]): void;
  addErrors(rows: MappedError[]): void;
  /** save_files_in: the files of the folder open in the editor are saved first. */
  saveFilesIn(folder: Location): Promise<boolean>;
  /** The .py file of the current tab: Run Program offers it first. */
  currentPythonFile(): Location | null;
}

// ui/main_run.py TRACEBACK_BLOCK: a complete traceback, its frame lines, then the exception line.
const TRACEBACK_BLOCK = /Traceback \(most recent call last\):\n(?:[ \t].*\n)+(\S.*)\n/g;

export interface RunOptions {
  hooks: RunHooks;
  python: PythonBridge;
  session: ProjectSession;
  stores: Map<string, FileStore>;
  settings: Settings;
  dialogs: Dialogs;
  view: RunView;
}

/**
 * The folder of a program into Python, where upstream's copy_program and build_program_web read
 * it; caches, version control and hidden files left out. Returns the program's path there.
 */
export async function copyProgramIntoPython(
  python: PythonBridge,
  store: FileStore,
  entry: Location,
): Promise<string> {
  const folder = parentPath(entry.path);
  const folderInPython = pythonPath({ store: entry.store, path: folder || '.' });
  for (const path of await walkFiles(store, folder)) {
    const relative = folder ? path.slice(folder.length + 1) : path;
    if (relative.split('/').some((part) => SKIPPED.has(part) || part.startsWith('.'))) continue;
    const data = await store.read(path);
    if (data) await python.writeFile(`${folderInPython}/${relative}`, data);
  }
  return `${folderInPython}/${baseName(entry.path)}`;
}

async function sha12(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/** Where the flashes of the programs live: OPFS simulator/<key>/flash, as config_dir()/simulator. */
async function flashRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('simulator', { create: true });
  } catch {
    return null;
  }
}

export class RunController {
  readonly simulator: Simulator;
  private program: Location | null = null;
  private flash: FileStore | null = null;
  private flashWrites: Promise<void> = Promise.resolve();
  private readonly memoryFlashes = new Map<string, MemoryStore>();
  private frameWaiter: ((pixels: Uint8Array | null) => void) | null = null;
  /** Everything the program printed in this run, for tests and for whoever reads it back. */
  transcript = '';
  /** Output of a project not yet read for tracebacks: half a traceback waits for the rest. */
  private trace = '';

  constructor(
    private readonly options: RunOptions,
    screen: HTMLElement,
  ) {
    const view = options.view;
    this.simulator = new Simulator(screen, {
      output: (text) => {
        this.transcript += text;
        if (this.simulator.mode === 'program') view.terminal(text);
        else {
          view.output(text.replace(/\r\n/g, '\n'));
          if (this.simulator.mode === 'project') this.readTracebacks(text);
        }
      },
      state: (state) => {
        view.state(state, this.simulator.mode === 'program');
        // ui/main_run.py: the terminal takes the focus, as a board's serial console
        if (state === 'running' && this.simulator.mode === 'program') view.focusTerminal();
      },
      flash: (change) => this.saveFlash(change),
      reset: () => void this.programReset(),
      shortcut: (shift) => {
        if (shift) void this.stop();
        else if (!this.running) void this.runProject();
      },
      frame: (pixels) => {
        this.frameWaiter?.(pixels);
        this.frameWaiter = null;
      },
    });
  }

  get running(): boolean {
    return this.simulator.running;
  }

  get isProgram(): boolean {
    return this.simulator.mode === 'program';
  }

  /** Run → Start (F5): the open project, generated by upstream, in the simulator. */
  async runProject(): Promise<boolean> {
    const { session, view } = this.options;
    if (this.running) return false;
    // ui/main_run.py saves first; a project already saved and unchanged runs as it is.
    if ((session.modified || !session.location) && !(await session.save())) return false;
    this.options.hooks.setErrors([]);
    const start = await this.prepareProject('project');
    if (!start) return false;
    // ui/main_run.py: compile_python before the simulator; an error stops here
    const errors = await this.options.hooks.compile(
      '/sim/project',
      start.files
        .map(([name]) => name)
        .filter((name) => name.endsWith('.py') && !name.includes('/')),
    );
    if (errors.length) {
      this.options.hooks.setErrors(errors);
      for (const error of errors) view.output(`${error.message}\n`);
      return false;
    }
    view.output(tr('{target} compilation completed', { target: 'MicroPython' }) + '\n');
    this.program = null;
    this.transcript = '';
    this.trace = '';
    this.options.view.clearTerminal();
    await this.simulator.start(start);
    view.status('');
    return true;
  }

  /** The first frame of the project, as build/preview.py takes it: the RGB565 frame buffer. */
  async firstFrame(): Promise<Uint8Array | null> {
    if (this.running) return null;
    const start = await this.prepareProject('frame');
    if (!start) return null;
    const pixels = new Promise<Uint8Array | null>((resolve) => (this.frameWaiter = resolve));
    this.transcript = '';
    await this.simulator.start(start);
    const result = await pixels;
    await this.simulator.stop();
    return result;
  }

  private async prepareProject(mode: 'project' | 'frame'): Promise<SimStart | null> {
    const { python, view } = this.options;
    if (mode === 'project')
      view.output(tr('Generating in {output}', { output: 'build/py' }) + '\n');
    try {
      const generated = await python.call<{
        directory: string;
        files: string[];
        warnings: string[];
        width: number;
        height: number;
        board: string;
      }>('sim_project');
      for (const warning of mode === 'project' ? generated.warnings : []) {
        view.output(tr('Warning: {warning}', { warning }) + '\n');
      }
      const files: SimFile[] = [];
      for (const name of generated.files) {
        const data = await python.readFile(`${generated.directory}/${name}`);
        if (data) files.push([name, data]);
      }
      return {
        mode,
        width: generated.width,
        height: generated.height,
        board: generated.board,
        entry: 'main.py',
        system: [],
        files,
      };
    } catch (error) {
      view.output(`${message(error)}\n`);
      return null;
    }
  }

  /** Run → Stop (Shift+F5). */
  stop(): Promise<void> {
    return this.simulator.stop();
  }

  /** Run → Restart: the program again, or the project. */
  async restart(): Promise<boolean> {
    const program = this.isProgram ? this.program : null;
    await this.simulator.stop();
    return program ? this.runProgram(program) : this.runProject();
  }

  lastProgram(): Location | null {
    return this.options.settings.get<Location | null>(LAST_PROGRAM, null);
  }

  /** Run → Run Program…: a .py file and its folder, as on a board; a terminal for the keys. */
  async runProgram(entry?: Location): Promise<boolean> {
    const { python, stores, settings, dialogs, view } = this.options;
    if (this.running) {
      view.status(tr('Stop the simulator first.'));
      return false;
    }
    if (!entry) {
      const chosen = await dialogs.choose({
        mode: 'open',
        title: tr('Run Program'),
        stores: [...stores.values()],
        suggested: this.options.hooks.currentPythonFile() ?? this.lastProgram(),
        accept: (name) => name.toLowerCase().endsWith('.py'),
      });
      if (!chosen) return false;
      entry = chosen;
    }
    const store = stores.get(entry.store);
    if (!store) return false;
    if (
      !(await this.options.hooks.saveFilesIn({ store: entry.store, path: parentPath(entry.path) }))
    ) {
      return false;
    }
    try {
      const folder = parentPath(entry.path);
      const entryInPython = await copyProgramIntoPython(python, store, entry);
      // Its flash, as the last run left it.
      const key = await sha12(`${entry.store}:${folder}`);
      const flash = await this.flashStore(key);
      const pythonFlash = `${PYTHON_FLASH}/${key}`;
      await python.call('sim_reset_folder', pythonFlash);
      for (const path of await walkFiles(flash)) {
        const data = await flash.read(path);
        if (data) await python.writeFile(`${pythonFlash}/${path}`, data);
      }
      const prepared = await python.call<{
        files: string[];
        board: string;
        width: number;
        height: number;
        entry: string;
        system: string[];
      }>('sim_program', entryInPython, pythonFlash);
      const files: SimFile[] = [];
      for (const path of prepared.files) {
        const data = await python.readFile(`${pythonFlash}/${path}`);
        if (!data) continue;
        files.push([path, data]);
        const before = await flash.read(path);
        if (!before || !sameBytes(before, data)) await flash.write(path, data);
      }
      const system: SimFile[] = [];
      for (const path of prepared.system) {
        const data = await python.readFile(path);
        if (data) system.push([baseName(path), data]);
      }
      settings.set(LAST_PROGRAM, entry);
      this.program = entry;
      this.flash = flash;
      this.transcript = '';
      view.clearTerminal();
      view.output(
        tr('Program {name}, {width}×{height}; its flash is {flash}', {
          name: baseName(entry.path),
          width: prepared.width,
          height: prepared.height,
          flash: `simulator/${key}/flash`,
        }) + '\n',
      );
      await this.simulator.start({
        mode: 'program',
        width: prepared.width,
        height: prepared.height,
        board: prepared.board,
        entry: prepared.entry,
        system,
        files,
      });
      return true;
    } catch (error) {
      view.output(`${message(error)}\n`);
      return false;
    }
  }

  /** Run → Erase Program Flash…: the files the last program wrote; its folder is not touched. */
  async eraseProgramFlash(): Promise<boolean> {
    const { dialogs, view } = this.options;
    const last = this.lastProgram();
    if (!last) {
      view.status(tr('Run a program first: Run → Run Program…'));
      return false;
    }
    if (this.running && this.isProgram) {
      view.status(tr('Stop the simulator first.'));
      return false;
    }
    const folder = parentPath(last.path);
    const label = this.options.stores.get(last.store)?.label ?? last.store;
    const yes = await dialogs.message(
      tr('Erase Program Flash…'),
      tr(
        'Erase the simulated flash of {folder}? The files the program wrote are lost; your folder is not touched.',
        { folder: folder ? `${label}: ${folder}` : label },
      ),
      [
        { label: tr('Yes'), value: true },
        { label: tr('No'), value: false, primary: true },
      ],
      false,
    );
    if (!yes) return false;
    const key = await sha12(`${last.store}:${folder}`);
    const root = await flashRoot();
    if (root) await root.removeEntry(key, { recursive: true }).catch(() => {});
    this.memoryFlashes.delete(key);
    view.status(tr('Program flash erased.'));
    return true;
  }

  /** ui/main_run.py _sim_output: complete tracebacks become rows of the Errors panel. */
  private readTracebacks(text: string): void {
    this.trace += text.replace(/\r\n/g, '\n');
    const blocks = [...this.trace.matchAll(TRACEBACK_BLOCK)];
    const last = blocks.at(-1);
    const rest = last ? this.trace.slice((last.index ?? 0) + last[0].length) : this.trace;
    const start = rest.lastIndexOf('Traceback (most recent call last)');
    this.trace = start >= 0 ? rest.slice(start).slice(-20000) : rest.slice(-40);
    if (!blocks.length) return;
    const complete = blocks.map((block) => block[0]).join('');
    void this.options.hooks.traceErrors(complete).then((rows) => {
      if (rows.length) this.options.hooks.addErrors(rows);
    });
  }

  /** Keys typed in the terminal: the program's serial port. */
  type(data: string): void {
    if (this.isProgram) this.simulator.type(data);
  }

  private async flashStore(key: string): Promise<FileStore> {
    const root = await flashRoot();
    if (root) {
      const folder = await root.getDirectoryHandle(key, { create: true });
      return new HandleStore(
        `flash:${key}`,
        'flash',
        await folder.getDirectoryHandle('flash', { create: true }),
      );
    }
    let memory = this.memoryFlashes.get(key);
    if (!memory) {
      memory = new MemoryStore(`flash:${key}`, 'flash');
      this.memoryFlashes.set(key, memory);
    }
    return memory;
  }

  /** What the program wrote in its flash, kept for the next run. One write at a time, in order. */
  private saveFlash(change: FlashChange): void {
    const flash = this.flash;
    if (!flash) return;
    this.flashWrites = this.flashWrites.then(async () => {
      try {
        for (const [path, data] of change.changed) await flash.write(path, data);
        for (const path of change.removed) await flash.remove(path);
      } catch (error) {
        this.options.view.output(`${tr('Program flash')}: ${message(error)}\n`);
      }
    });
  }

  /** machine.reset() in the program: it starts again with its flash as it is. */
  private async programReset(): Promise<void> {
    const flash = this.flash;
    if (!flash) return;
    await this.flashWrites;
    const files: SimFile[] = [];
    for (const path of await walkFiles(flash)) {
      const data = await flash.read(path);
      if (data) files.push([path, data]);
    }
    this.simulator.restartWith(files);
  }

  /** Waits until what the program wrote is in the flash store: for tests. */
  flushed(): Promise<void> {
    return this.flashWrites;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
