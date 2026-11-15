// Messages between the page and the Python worker.

export interface PythonError {
  type: string;
  message: string;
  traceback?: string;
  /** ExternalChangeError only: the file was removed, not changed. */
  deleted?: boolean;
  /** DeviceError only: upstream's error code, the board's output and the text for the user. */
  code?: string;
  output?: string;
  text?: string;
  /** DeviceError only: mapped errors (a syntax error of the project) and warnings found before. */
  errors?: unknown[];
  warnings?: string[];
}

export type BridgeReply = { ok: true; result: unknown } | { ok: false; error: PythonError };

export interface PythonInfo {
  upstreamVersion: string;
  python: string;
  pyodide: string;
  /** Milliseconds from the worker's start to the bridge being ready. */
  startMs: number;
}

/** Page → worker. */
export interface CallRequest {
  kind: 'call';
  id: number;
  method: string;
  args: unknown[];
}

/** Page → worker: a file of Pyodide's file system, which upstream reads and writes. */
export type FsRequest =
  | { kind: 'fs'; id: number; op: 'write'; path: string; data: Uint8Array }
  | { kind: 'fs'; id: number; op: 'read' | 'remove' | 'folder'; path: string };

/** Page → worker: an operation of upstream's DeviceSession (py/lms_board.py), with JSPI. */
export interface BoardRequest {
  kind: 'board';
  id: number;
  method: string;
  args: unknown[];
}

/** Page → worker, about the serial port the page holds (src/board/web-serial.ts). */
export type SerialToWorker =
  | { kind: 'serial'; op: 'open'; port: string; info: PortInfo }
  | { kind: 'serial'; op: 'data'; port: string; data: Uint8Array }
  | { kind: 'serial'; op: 'close'; port: string }
  | { kind: 'serial'; op: 'drained'; id: number }
  /** Stops the board operation after its current command. */
  | { kind: 'serial'; op: 'cancel' };

export interface PortInfo {
  port: string;
  description?: string;
  vid?: number;
  pid?: number;
}

export type WorkerRequest = CallRequest | FsRequest | BoardRequest | SerialToWorker;

/** Worker → page, from a board operation. */
export type SerialFromWorker =
  | { kind: 'serial-write'; port: string; data: Uint8Array }
  | { kind: 'serial-drain'; port: string; id: number }
  | { kind: 'board-progress'; sent: number; total: number; name: string; size: number };

/** Worker → page. */
export type WorkerMessage =
  | { kind: 'status'; stage: 'loading-python' | 'loading-upstream' }
  | { kind: 'ready'; info: PythonInfo }
  | { kind: 'failed'; error: PythonError }
  | ({ kind: 'reply'; id: number } & BridgeReply)
  | SerialFromWorker;

/** What generate and export_board return: every file written, by relative path. */
export interface GeneratedFiles {
  files: Record<string, string>;
  warnings: string[];
}

export interface GeneratedProject extends GeneratedFiles {
  modules: string[];
}

export interface BoardExport extends GeneratedFiles {
  profile: string;
}
