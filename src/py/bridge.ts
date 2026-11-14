// The page's side of the Python worker: typed calls that return promises.
import type {
  BoardExport,
  GeneratedProject,
  PythonError,
  PythonInfo,
  WorkerMessage,
  WorkerRequest,
} from './protocol.ts';

/** What the bridge needs of a Worker; a fake one stands in for it in the unit tests. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
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
  constructor(error: PythonError) {
    super(error.message);
    this.name = 'PythonCallError';
    this.type = error.type;
    this.traceback = error.traceback;
    this.deleted = error.deleted;
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
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;

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
  }

  onState(listener: (state: PythonState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.send<T>((id) => ({ kind: 'call', id, method, args }));
  }

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
