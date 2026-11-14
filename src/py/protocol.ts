// Messages between the page and the Python worker.

export interface PythonError {
  type: string;
  message: string;
  traceback?: string;
  /** ExternalChangeError only: the file was removed, not changed. */
  deleted?: boolean;
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

export type WorkerRequest = CallRequest | FsRequest;

/** Worker → page. */
export type WorkerMessage =
  | { kind: 'status'; stage: 'loading-python' | 'loading-upstream' }
  | { kind: 'ready'; info: PythonInfo }
  | { kind: 'failed'; error: PythonError }
  | ({ kind: 'reply'; id: number } & BridgeReply);

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
