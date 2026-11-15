// The board, as upstream's ui/main_device.py (DeviceMixin): the connection, one operation at a
// time, the upload and its progress, Stop, Restart, the console. The operations are upstream's
// DeviceSession, in the Python worker (py/lms_board.py); this side holds the port and the queue.
import { BoardPort, portKey, webSerialAvailable } from '../board/web-serial.ts';
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
type Success = (result: unknown) => void | Promise<void>;

export class DeviceController {
  port: BoardPort | null = null;
  /** The profile the connection was opened for. */
  private profile: string | null = null;
  info: BoardInfo | null = null;
  appActive = false;
  /** The operation running, if any; background ones (the Files panel) do not lock the IDE. */
  private running: { background: boolean } | null = null;
  private deferred: [Operation, Success | undefined] | null = null;
  private next: (() => unknown) | null = null;
  private cancelling = false;
  private readonly listeners = new Set<() => void>();
  private decoder = new TextDecoder();
  liveUploadKey: string | null = null;
  liveDesignKey: string | null = null;

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
    session.onChange(() => this.syncSession());
    this.update();
  }

  /** Web Serial and JSPI are there (Chromium); elsewhere the Device menu says so instead. */
  get available(): boolean {
    return this.serial !== null;
  }

  get connected(): boolean {
    return this.port !== null;
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
    if (following) following();
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
    if (!this.serial) {
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
    if (!chosen) return false;
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
    port.onConsole = (data) => this.view.append(this.decoder.decode(data, { stream: true }));
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
    );
  }

  private notAvailable(): void {
    this.view.message(
      tr(
        'This browser has no Web Serial: the board works in Chrome or Edge, or from the desktop LVGL MPY Studio.',
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
    await this.disconnect();
    this.view.message(tr('The board was disconnected.'));
  }

  async disconnect(): Promise<void> {
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
        if (result.output) this.view.append(result.output);
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
