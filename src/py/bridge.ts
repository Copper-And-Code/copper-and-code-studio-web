// The page's side of the Python worker: typed calls that return promises.
import type {
  BoardExport,
  GeneratedProject,
  PythonError,
  PythonInfo,
  SerialFromWorker,
  SerialToWorker,
  WorkerMessage,
  WorkerRequest,
} from './protocol.ts';

/** What the bridge needs of a Worker; a fake one stands in for it in the unit tests. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export type PythonState =
  | { stage: 'loading-python' | 'loading-upstream' }
  | { stage: 'ready'; info: PythonInfo }
  | { stage: 'failed'; error: PythonError };

/** A failure raised by Python, with its type and traceback. */
export class PythonCallError extends Error {
  readonly type: string;
  readonly traceback: string | undefined;
  readonly deleted: boolean | undefined;
  /** A DeviceError of the board: its code, output, text, errors and warnings. */
  readonly device: PythonError | undefined;
  constructor(error: PythonError) {
    super(error.text ?? error.message);
    this.name = 'PythonCallError';
    this.type = error.type;
    this.traceback = error.traceback;
    this.deleted = error.deleted;
    this.device = error.code ? error : undefined;
  }
}

export function startPythonWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'python',
  }) as WorkerLike;
}

export class PythonBridge {
  readonly ready: Promise<PythonInfo>;
  state: PythonState = { stage: 'loading-python' };
  private readonly listeners = new Set<(state: PythonState) => void>();
  private readonly serialListeners = new Set<(message: SerialFromWorker) => void>();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  /** The worker never started: nothing answers, so every call fails with this. */
  private lost: PythonCallError | null = null;

  constructor(private readonly worker: WorkerLike = startPythonWorker()) {
    let resolveReady!: (info: PythonInfo) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.ready.catch(() => {}); // a failure is reported through the state as well
    worker.addEventListener('message', ({ data }) => {
      switch (data.kind) {
        case 'status':
          this.setState({ stage: data.stage });
          break;
        case 'ready':
          this.setState({ stage: 'ready', info: data.info });
          resolveReady(data.info);
          break;
        case 'failed':
          this.setState({ stage: 'failed', error: data.error });
          rejectReady(new PythonCallError(data.error));
          break;
        case 'serial-write':
        case 'serial-drain':
        case 'board-progress':
          for (const listener of this.serialListeners) listener(data);
          break;
        case 'reply': {
          const waiting = this.pending.get(data.id);
          if (!waiting) return;
          this.pending.delete(data.id);
          if (data.ok) waiting.resolve(data.result);
          else waiting.reject(new PythonCallError(data.error));
          break;
        }
      }
    });
    // The worker's script did not load, or threw before Python was ready: no message will ever
    // come. Once ready, the worker answers every call, failures included (host.ts), and an error
    // outside a call does not stop it.
    worker.addEventListener('error', (event) => {
      if (this.state.stage === 'ready' || this.state.stage === 'failed') return;
      const error: PythonError = {
        type: 'WorkerError',
        // as the worker's own reasons (worker.ts): a detail after "Python failed to start"
        message: event.message || 'the worker script did not load',
      };
      this.lost = new PythonCallError(error);
      this.setState({ stage: 'failed', error });
      rejectReady(this.lost);
      for (const waiting of this.pending.values()) waiting.reject(this.lost);
      this.pending.clear();
    });
  }

  onState(listener: (state: PythonState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Calls sent to the worker and not answered yet: for lmsCapture.idle(). */
  get busy(): number {
    return this.pending.size;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const before = this.before;
    if (before)
      return before(method).then(() => this.send<T>((id) => ({ kind: 'call', id, method, args })));
    return this.send<T>((id) => ({ kind: 'call', id, method, args }));
  }

  /** An operation of upstream's DeviceSession on the connected board (py/lms_board.py). */
  board<T>(method: string, ...args: unknown[]): Promise<T> {
    const before = this.before;
    const send = () => this.send<T>((id) => ({ kind: 'board', id, method, args }));
    return before ? before(method).then(send) : send();
  }

  /** The port's bytes and events, to the worker. */
  serial(message: SerialToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  /** What a board operation writes to the port, and its progress. */
  onSerial(listener: (message: SerialFromWorker) => void): () => void {
    this.serialListeners.add(listener);
    return () => this.serialListeners.delete(listener);
  }

  /** Awaited before each call: the fonts are converted before a call that generates code. */
  before: ((method: string) => Promise<void>) | null = null;

  /** Writes a file into Pyodide's file system. The data is copied, the caller keeps its own. */
  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.send((id) => ({ kind: 'fs', id, op: 'write', path, data }));
  }

  /** A file of Pyodide's file system, or null if there is none. */
  readFile(path: string): Promise<Uint8Array | null> {
    return this.send((id) => ({ kind: 'fs', id, op: 'read', path }));
  }

  /** Creates a folder of Pyodide's file system, with its parents. */
  makeFolder(path: string): Promise<void> {
    return this.send((id) => ({ kind: 'fs', id, op: 'folder', path }));
  }

  removeFile(path: string): Promise<void> {
    return this.send((id) => ({ kind: 'fs', id, op: 'remove', path }));
  }

  private send<T>(request: (id: number) => WorkerRequest): Promise<T> {
    if (this.lost) return Promise.reject(this.lost);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(request(id));
    });
  }

  /** The project's MicroPython code, from the text of its project file. */
  generate(projectText: string): Promise<GeneratedProject> {
    return this.call('generate', projectText);
  }

  /** The sources for a board: the project's own board, or the profile named. */
  exportBoard(projectText: string, profileId?: string): Promise<BoardExport> {
    return profileId === undefined
      ? this.call('export_board', projectText)
      : this.call('export_board', projectText, profileId);
  }

  private setState(state: PythonState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
