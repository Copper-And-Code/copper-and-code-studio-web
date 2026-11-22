// The board, as upstream's ui/main_device.py (DeviceMixin): the connection, one operation at a
// time, the upload and its progress, Stop, Restart, the console. The operations are upstream's
// DeviceSession, in the Python worker (py/lms_board.py); this side holds the port and the queue.
import { BoardPort, portKey, webSerialAvailable } from '../board/web-serial.ts';
import { stackSwitching } from '../board/worker-board.ts';
import { tr } from '../i18n/tr.ts';
import { PythonCallError, type PythonBridge } from '../py/bridge.ts';
import type { ProjectSession } from '../project/session.ts';
import type { Settings } from '../storage/settings.ts';
import type { MappedError } from './code.ts';

/** What the Device Console and the rest of the window show of the board. */
export interface DeviceView {
  /** What the board printed. */
  append(text: string): void;
  /** A message of the IDE in the console, in grey. */
  message(text: string): void;
  /** Keys reach the board only when ready; reason says why not. */
  setReady(ready: boolean, reason: string): void;
  setBusy(busy: boolean): void;
  /** The status bar; ms 0 keeps it. */
  status(text: string, ms?: number): void;
  /** The line under the menus: connected to…, app active. */
  connection(text: string): void;
  /** Shows the Device Console, without taking the keyboard. */
  raise(): void;
  /** Gives the keyboard to the Device Console. */
  focusConsole(): void;
  /** UploadProgress: opened before an upload, reported to, finished at the end. */
  progress: {
    open(rate: number, cancel: () => void): void;
    report(sent: number, total: number, name: string, size: number): void;
    rate(): number;
    finish(): void;
  };
}

export interface DeviceHooks {
  appendError(text: string): void;
  addErrors(rows: MappedError[]): void;
  showWarnings(warnings: string[]): void;
  /** The project is saved first, as upload_board does with save_project. */
  saveProject(): Promise<boolean>;
  /** _show_budget, after the board's free memory was read. */
  boardMemory(): void;
  /** A line of the Output panel. */
  output(text: string): void;
  /** QMessageBox.question: Yes is true. */
  ask(title: string, text: string): Promise<boolean>;
  /** QInputDialog.getText: null when cancelled. */
  askText(title: string, label: string, value: string): Promise<string | null>;
  /** The board's side of the Files panel reads this folder again (reload_folder). */
  reloadBoardFolder(folder: string): void;
  /** config_dir changed (an autostart transaction): it is kept in the browser's storage. */
  saveConfig(): Promise<void>;
  /** The demonstration board, powered on as a port (src/board/demo-board.ts); null without one. */
  demoBoard?(): Promise<SerialPort | null>;
}

/** A file of the PC or of a place, to copy to the board under its relative name. */
export interface UploadItem {
  name: string;
  read(): Promise<Uint8Array>;
}

interface UploadFilesResult {
  destination: string;
  files: string[];
  bytes: number;
  warnings: string[];
}

export interface BoardInfo {
  compatible?: boolean;
  memoryFree?: number;
  filesystemFree?: number;
  mpy?: number;
  [key: string]: unknown;
}

interface UploadResult {
  appPath: string;
  warnings: string[];
  sourcemap: unknown;
  output: string;
  active: boolean;
  uploadKey: string | null;
  designKey: string | null;
}

interface ProjectBoard {
  id: string;
  name: string;
  adapter: string;
}

type Operation = () => Promise<unknown>;

/** ui/main_device.py LIVE_DELAY_MS */
const LIVE_DELAY_MS = 500;
type Success = (result: unknown) => void | Promise<void>;

export class DeviceController {
  port: BoardPort | null = null;
  /** The profile the connection was opened for. */
  private profile: string | null = null;

  get profileId(): string | null {
    return this.profile;
  }
  info: BoardInfo | null = null;
  appActive = false;
  /** The operation running, if any; background ones (the Files panel) do not lock the IDE. */
  private running: { background: boolean } | null = null;
  private deferred: [Operation, Success | undefined] | null = null;
  /** What the Files panel and the file tabs asked while the board was busy (_board_pending). */
  private pending: {
    operation: Operation;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private next: (() => unknown) | null = null;
  /** What followed the last operation typed a line at the board's prompt (runOnBoard). */
  private typed = false;
  private cancelling = false;
  private readonly listeners = new Set<() => void>();
  private decoder = new TextDecoder();
  liveUploadKey: string | null = null;
  liveDesignKey: string | null = null;
  /** Device → Live Editing (device/live, on by default). */
  liveOn: boolean;
  private livePage: string | null = null;
  /** _device_sourcemap, _device_trace, _device_mapped_traces. */
  private sourcemap: unknown = null;
  private trace = '';
  private readonly mapped = new Set<string>();
  private traceTimer: ReturnType<typeof setTimeout> | undefined;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly python: PythonBridge,
    private readonly session: ProjectSession,
    private readonly settings: Settings,
    private readonly view: DeviceView,
    private readonly hooks: DeviceHooks,
    private readonly serial: Serial | null = webSerialAvailable() ? navigator.serial : null,
  ) {
    python.onSerial((message) => {
      if (message.kind === 'board-progress') {
        this.view.progress.report(message.sent, message.total, message.name, message.size);
      }
    });
    this.liveOn = settings.get<boolean>('device/live', true);
    session.onChange(() => {
      this.syncSession();
      this.scheduleLive();
    });
    this.update();
  }

  /** _device_output: what the board printed, and its tracebacks as rows of the Errors panel. */
  private output(text: string): void {
    if (!text) return;
    this.view.append(text);
    this.trace = (this.trace + text).slice(-20000);
    if (!this.sourcemap) return;
    clearTimeout(this.traceTimer);
    this.traceTimer = setTimeout(() => void this.mapTrace(), 200);
  }

  private async mapTrace(): Promise<void> {
    let rows: MappedError[];
    try {
      rows = await this.python.board<MappedError[]>('trace_errors', this.trace, this.sourcemap);
    } catch {
      return;
    }
    const fresh = rows.filter((row) => {
      const key = `${row.file}:${row.line}`;
      if (this.mapped.has(key)) return false;
      this.mapped.add(key);
      return true;
    });
    if (fresh.length) this.hooks.addErrors(fresh);
  }

  // ---- live editing: MainWindow._schedule_live and _send_live ----

  toggleLive(enabled: boolean): void {
    this.liveOn = enabled;
    this.settings.set('device/live', enabled);
    this.scheduleLive();
    this.update();
  }

  /** After a change, or another page shown: from Code or Simulator the last open page stays. */
  scheduleLive(page?: string | null): void {
    if (page) this.livePage = page;
    if (this.liveOn && this.appActive && this.liveUploadKey !== null) {
      clearTimeout(this.liveTimer);
      this.liveTimer = setTimeout(() => this.sendLive(), LIVE_DELAY_MS);
    }
  }

  private sendLive(): void {
    const uploadKey = this.liveUploadKey;
    if (!this.liveOn || !this.appActive || uploadKey === null) return;
    if (this.running) {
      this.liveTimer = setTimeout(() => this.sendLive(), LIVE_DELAY_MS);
      return;
    }
    this.task(
      () =>
        this.python.board<{ status: string; designKey?: string }>(
          'live_send',
          uploadKey,
          this.liveDesignKey,
          this.livePage,
        ),
      (result) => {
        if (result.status === 'stale') {
          this.view.status(tr('The code changed: press F5 to send it to the board.'), 5000);
        } else if (result.status === 'sent') {
          this.liveDesignKey = result.designKey ?? null;
          this.view.status(tr('Board updated.'), 3000);
        }
      },
    );
  }

  /** Web Serial and JSPI are there (Chromium); elsewhere the Device menu says so instead. */
  get available(): boolean {
    return this.serial !== null;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  /** Device → Connect to Demo Board: needs only JSPI, for Python to wait for the board. */
  get demoAvailable(): boolean {
    return stackSwitching() && this.hooks.demoBoard !== undefined;
  }

  /** Connected to the demonstration board, not to hardware. */
  get demo(): boolean {
    return this.port?.demo ?? false;
  }

  private demoRequested = false;

  /** Connect to Demo Board: the real flow of a board, with no hardware (demo-board.ts). */
  async connectDemo(): Promise<boolean> {
    if (this.running) return false;
    if (this.port) await this.disconnect();
    this.demoRequested = true;
    try {
      return await this.withConnection(() => true, true);
    } finally {
      this.demoRequested = false;
    }
  }

  get busy(): boolean {
    return this.running !== null && !this.running.background;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** _update_device_actions, for what lives outside the menus. */
  private update(): void {
    const live = this.connected && this.running === null;
    const reason = live
      ? ''
      : this.busy
        ? tr('IDE operation in progress…')
        : this.connected
          ? tr('Console not available.')
          : tr('Board not connected');
    this.view.setReady(live, reason);
    this.view.setBusy(this.busy);
    if (this.port) {
      this.view.connection(
        tr('Connected to {port}', { port: this.port.label }) +
          (this.appActive ? ' · ' + tr('app active') : ''),
      );
    } else {
      this.view.connection(this.session.state?.board ? tr('Board not connected') : '');
    }
    for (const listener of this.listeners) listener();
  }

  /** _sync_device_session: a session is valid only for the profile it was opened with. */
  private syncSession(): void {
    if (this.running === null && this.port && this.profile !== this.session.state?.board) {
      void this.disconnect();
    } else {
      this.update();
    }
  }

  /**
   * _device_task: one operation at a time. While a background one runs, an operation of the user
   * waits for it instead of being refused.
   */
  task<T>(
    operation: () => Promise<T>,
    success?: (result: T) => void | Promise<void>,
    background = false,
    failure?: (error: unknown) => void,
  ): boolean {
    if (this.running) {
      if (this.running.background && !background && this.deferred === null) {
        this.deferred = [operation, success as Success | undefined];
        return true;
      }
      return false;
    }
    this.running = { background };
    this.cancelling = false;
    if (this.port) this.port.ideOwns = true;
    if (!background) this.view.raise(); // the desktop's console is a dock, always in sight
    this.update();
    void (async () => {
      try {
        const result = await operation();
        if (success) await success(result);
      } catch (error) {
        this.failed(error);
        failure?.(error);
      } finally {
        this.finished();
      }
    })();
    return true;
  }

  private failed(error: unknown): void {
    this.next = null;
    const device = error instanceof PythonCallError ? error.device : undefined;
    const text = error instanceof Error ? error.message : String(error);
    this.view.message(text);
    this.hooks.showWarnings(device?.warnings ?? []);
    if (device?.errors?.length) {
      this.hooks.addErrors(device.errors as MappedError[]);
    } else {
      this.hooks.appendError(`${tr('Device Error')}: ${text}`);
    }
    this.view.status(tr('Device Error'), 5000);
  }

  private finished(): void {
    const background = this.running?.background ?? false;
    if (!background) this.view.progress.finish();
    this.running = null;
    if (this.port) this.port.ideOwns = false;
    let following = this.next;
    this.next = null;
    if (following === null && this.deferred !== null) {
      const [operation, success] = this.deferred;
      this.deferred = null;
      following = () => this.task(operation, success);
    }
    this.syncSession();
    this.typed = false;
    if (following) following();
    // What the Files panel asked while the board was busy, if it is free. Not after a program
    // typed at the prompt: an operation enters the raw REPL with a Ctrl-C, which would stop it
    // (_device_finished runs nothing after what followed). It waits for the board's next turn.
    if (!this.typed) this.runPending();
  }

  /**
   * _board_task: an operation of the Files panel or of a file tab, as a promise. It waits for the
   * board to be free, and runs in the background, so that it does not lock the IDE.
   */
  boardTask<T>(method: string, ...args: unknown[]): Promise<T> {
    // without a board it fails now: kept, it would run on whichever board is connected next
    if (!this.port) return Promise.reject(new Error(tr('Board not connected')));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        operation: () => this.python.board<T>(method, ...args),
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.runPending();
    });
  }

  private runPending(): void {
    if (this.running || !this.port) return;
    const next = this.pending.shift();
    if (!next) return;
    this.task(
      next.operation,
      (result) => next.resolve(result),
      true,
      (error) => next.reject(error),
    );
  }

  private clearPending(): void {
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) item.reject(new Error(tr('Board not connected')));
  }

  cancel(): void {
    if (this.running && !this.cancelling) {
      this.cancelling = true;
      this.python.serial({ kind: 'serial', op: 'cancel' });
      this.view.status(tr('Cancelling after the current command…'), 0);
    }
  }

  // ---- the connection ----

  private board(): Promise<ProjectBoard | null> {
    return this.python.board<ProjectBoard | null>('project_board');
  }

  /** The port remembered for the profile, among those the browser allows; else the user picks. */
  private async choosePort(profile: string, ask: boolean): Promise<SerialPort | null> {
    if (this.demoRequested) return (await this.hooks.demoBoard?.()) ?? null;
    if (!this.serial) return null;
    const key = this.settings.get<string>(`device/ports/${profile}`, '');
    if (!ask && key) {
      const known = (await this.serial.getPorts()).find((port) => portKey(port) === key);
      if (known) return known;
    }
    try {
      const port = await this.serial.requestPort();
      this.settings.set(`device/ports/${profile}`, portKey(port));
      return port;
    } catch {
      return null; // the user closed the browser's chooser
    }
  }

  /** _with_connection: run action, opening the connection first if it is missing. */
  async withConnection(action: () => unknown, choose = false): Promise<boolean> {
    if (this.port && !choose) {
      action();
      return true;
    }
    if (!this.serial && !(this.demoRequested && this.demoAvailable)) {
      this.notAvailable();
      return false;
    }
    if (this.running) return false;
    const board = await this.board();
    if (!board) {
      this.hooks.appendError(tr('Select a board profile in the project settings.'));
      return false;
    }
    const chosen = await this.choosePort(board.id, choose);
    if (!chosen) {
      // the browser's chooser closed without a port: say why nothing happens
      const text = tr('No port chosen: the board is not connected.');
      this.hooks.output(text);
      this.view.status(text, 5000);
      return false;
    }
    if (this.port) await this.disconnect();
    let port: BoardPort;
    try {
      port = await BoardPort.open(chosen, this.python, board.adapter);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.view.message(tr('The serial port is occupied by another process.') + `\n${text}`);
      this.hooks.appendError(`${tr('Device Error')}: ${text}`);
      return false;
    }
    this.port = port;
    this.profile = board.id;
    port.onConsole = (data) => this.output(this.decoder.decode(data, { stream: true }));
    port.onLost = () => void this.lost();
    return this.task(
      () => this.python.board<BoardInfo>('connect', port.name),
      (info) => {
        this.appActive = false;
        this.info = info;
        this.rememberMemory(info);
        this.view.message(JSON.stringify(info, null, 2));
        if (info.compatible) this.next = action;
        else this.hooks.appendError(tr('Firmware or resolution is incompatible with the profile.'));
      },
      false,
      // upstream's session dropped its port: the IDE's goes too, or it would say "Connected"
      // and fail every operation until Disconnect
      () => void this.disconnect(),
    );
  }

  private notAvailable(): void {
    this.view.message(
      tr(
        'This browser has no Web Serial: the board works in Chrome or Edge, or from the desktop Copper and Code Studio.',
      ),
    );
  }

  /** _remember_board_memory: the budget measures against the board's own free memory. */
  private rememberMemory(info: BoardInfo): void {
    if (this.profile && typeof info.memoryFree === 'number') {
      this.settings.set(
        `device/memory/${this.profile}`,
        JSON.stringify({ ram: info.memoryFree, flash: info.filesystemFree, mpy: info.mpy }),
      );
    }
    this.hooks.boardMemory();
  }

  /** The cable was pulled: the session closes and the queue is cleared (_run_board_pending). */
  private async lost(): Promise<void> {
    this.deferred = null;
    this.next = null;
    this.clearPending();
    await this.disconnect();
    this.view.message(tr('The board was disconnected.'));
  }

  async disconnect(): Promise<void> {
    this.clearPending();
    const port = this.port;
    this.port = null;
    this.profile = null;
    this.appActive = false;
    this.info = null;
    this.liveUploadKey = this.liveDesignKey = null;
    if (port) {
      await port.close();
      await this.python.board('disconnect').catch(() => {});
    }
    this.update();
  }

  connectDisconnect(): Promise<boolean> {
    if (this.port) return this.disconnect().then(() => true);
    return this.withConnection(() => true);
  }

  /** Change Port…: the browser's chooser, then the connection on the new port. */
  changePort(): Promise<boolean> {
    return this.withConnection(() => true, true);
  }

  showInfo(): boolean {
    return this.task(
      () => this.python.board<BoardInfo>('info'),
      (info) => {
        this.info = info;
        this.rememberMemory(info);
        this.view.message(JSON.stringify(info, null, 2));
      },
    );
  }

  // ---- the project on the board ----

  async upload(run: boolean): Promise<boolean> {
    if (!(await this.hooks.saveProject())) return false;
    return this.withConnection(() => this.startUpload(run));
  }

  private startUpload(run: boolean): boolean {
    const profile = this.profile ?? '';
    const rateKey = `device/uploadRate/${profile}`;
    this.view.status(tr('Uploading…'), 0);
    const started = this.task(
      () => this.python.board<UploadResult>('upload', run),
      (result) => {
        this.hooks.showWarnings(result.warnings);
        this.settings.set(rateKey, this.view.progress.rate());
        this.sourcemap = result.sourcemap ?? null;
        this.trace = '';
        this.mapped.clear();
        this.output(result.output ?? '');
        this.appActive = run && result.active;
        this.liveUploadKey = this.appActive ? result.uploadKey : null;
        this.liveDesignKey = this.appActive ? result.designKey : null;
        const message = run
          ? tr('Board application started; the LVGL timer remains active after bootstrap.')
          : tr('Upload completed');
        this.view.status(message, 5000);
        this.view.message(message);
      },
    );
    if (started)
      this.view.progress.open(this.settings.get<number>(rateKey, 0), () => this.cancel());
    return started;
  }

  stop(): boolean {
    return this.task(
      () => this.python.board<string>('stop'),
      (output) => {
        this.appActive = false;
        this.view.append(output);
        this.view.status(tr('Board stopped; the last image may remain visible.'), 5000);
      },
    );
  }

  restart(): boolean {
    this.appActive = false;
    return this.task(
      () => this.python.board<string>('restart'),
      (output) => this.view.append(output),
    );
  }

  // ---- files and programs outside the project ----

  /**
   * _confirm_and_upload_files: the files the board runs at power-on are asked about first, then
   * a folder that would hide a module of the same name; then runs once the board is free again.
   */
  async uploadFiles(
    items: UploadItem[],
    destination: string,
    compile = false,
    then?: () => unknown,
  ): Promise<boolean> {
    const names = items.map((item) => item.name);
    const protectedFiles = await this.python.board<string[]>(
      'protected_targets',
      names,
      destination,
    );
    if (
      protectedFiles.length &&
      !(await this.hooks.ask(
        tr('Upload Files'),
        tr(
          'The board runs these files at power-on, and they will be replaced:\n{files}\n\nContinue?',
          {
            files: protectedFiles.join('\n'),
          },
        ),
      ))
    ) {
      return false;
    }
    return this.withConnection(() => this.checkNamesThenUpload(items, destination, compile, then));
  }

  private checkNamesThenUpload(
    items: UploadItem[],
    destination: string,
    compile: boolean,
    then?: () => unknown,
  ): boolean {
    const names = items.map((item) => item.name);
    return this.task(
      () =>
        this.python
          .board<{ name: string; dir: boolean; size: number }[]>('list_dir', destination)
          .catch(() => []), // a folder that the upload creates
      async (entries) => {
        const shadowed = await this.python.board<string[]>('shadowed_modules', names, entries);
        if (shadowed.length) {
          const lines = shadowed.map((name) => `${name}/ — ${name}.py`).join('\n');
          const question = tr(
            'In {folder} on the board a folder and a module would have the same name:\n{names}\n\n`import` finds the folder, not the module. Upload anyway?',
            { folder: destination, names: lines },
          );
          if (!(await this.hooks.ask(tr('Upload Files'), question))) return;
        }
        this.next = () => void this.startUploadFiles(items, destination, compile, then);
      },
    );
  }

  private async startUploadFiles(
    items: UploadItem[],
    destination: string,
    compile: boolean,
    then?: () => unknown,
  ): Promise<boolean> {
    // the files go into Pyodide's file system first, where upstream reads them
    try {
      for (const item of items) {
        await this.python.writeFile(`/board-upload/${item.name}`, await item.read());
      }
    } catch (error) {
      this.failed(error);
      return false;
    }
    const rateKey = `device/uploadRate/${this.profile ?? ''}`;
    const started = this.task(
      () =>
        this.python.board<UploadFilesResult>(
          'upload_files',
          items.map((i) => i.name),
          destination,
          compile,
        ),
      (result) => {
        this.hooks.showWarnings(result.warnings);
        this.settings.set(rateKey, this.view.progress.rate());
        const message = tr('{count} files copied to {folder} on the board.', {
          count: result.files.length,
          folder: result.destination,
        });
        this.view.message(message);
        this.hooks.reloadBoardFolder(result.destination);
        this.view.status(message, 5000);
        if (then) this.next = then; // after the upload has finished and the board is free
      },
    );
    if (started)
      this.view.progress.open(this.settings.get<number>(rateKey, 0), () => this.cancel());
    return started;
  }

  /** run_file_on_board: a file of the board, or a line of Python, typed at its prompt. */
  async runFileOnBoard(text?: string): Promise<boolean> {
    let line = text;
    if (line === undefined) {
      const answer = await this.hooks.askText(
        tr('Run File on Board'),
        tr('A file of the board, such as /flash/shell.py, or a line of Python:'),
        this.settings.get<string>('device/runFile', '/flash/main.py'),
      );
      if (answer === null || !answer.trim()) return false;
      line = answer;
    }
    this.settings.set('device/runFile', line.trim());
    const chosen = line;
    return this.withConnection(() => this.runOnBoard(chosen));
  }

  /** _run_on_board: through the console, so that the program reads its keys from there. */
  private runOnBoard(text: string): boolean {
    if (!this.port) {
      this.view.message(tr('Console not available.'));
      return false;
    }
    return this.task(
      async () => {
        await this.python.board('leave_raw');
        return this.python.board<string>('run_line', text);
      },
      (line) => {
        // typed as soon as the board is free, before anything queued meanwhile; Ctrl-C first:
        // a program already running stops
        this.next = () => {
          this.typed = true;
          this.write(new TextEncoder().encode(`\x03${line}\r`));
          this.view.raise();
          this.view.focusConsole();
        };
      },
    );
  }

  /** install_autostart: the launcher in /main.py, the main.py it replaces kept on this side. */
  async installAutostart(): Promise<boolean> {
    if (
      !(await this.hooks.ask(
        tr('Install Autostart…'),
        tr(
          '/main.py on the board will be replaced. An existing main.py will be backed up locally; boot.py will not be changed. Continue?',
        ),
      ))
    ) {
      return false;
    }
    return this.task(
      () => this.python.board('install_autostart'),
      async () => {
        await this.hooks.saveConfig();
        this.view.status(tr('Autostart installed'), 5000);
      },
      false,
      () => void this.hooks.saveConfig(), // a failed transaction removed its folder
    );
  }

  async removeAutostart(): Promise<boolean> {
    if (
      !(await this.hooks.ask(
        tr('Remove Autostart…'),
        tr('Remove only the recognizable IDE launcher and restore any previous main.py?'),
      ))
    ) {
      return false;
    }
    return this.task(
      () => this.python.board('remove_autostart'),
      async () => {
        await this.hooks.saveConfig();
        this.view.status(tr('Autostart removed'), 5000);
      },
    );
  }

  /** _board_program_root. */
  programRoot(): Promise<string> {
    return this.python.board<string>('program_root');
  }

  // ---- the console ----

  /** Keys typed in the Device Console go to the board as they are. */
  write(data: Uint8Array): void {
    if (!this.port || this.running) return;
    this.port.write(data).catch((error: unknown) => {
      this.view.message(error instanceof Error ? error.message : String(error));
      this.update();
    });
  }
}
