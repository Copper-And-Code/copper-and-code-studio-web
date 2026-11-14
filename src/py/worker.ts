/// <reference lib="webworker" />
// The Python worker: Pyodide with upstream's packages, so the page never freezes while
// upstream works. Calls wait until Python is ready and are answered one at a time.
import type { PyodideInterface } from 'pyodide';
import { installUpstream, type PythonCall } from './boot.ts';
import { handleRequest } from './host.ts';
import type { PythonInfo, WorkerMessage, WorkerRequest } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: WorkerMessage) => self.postMessage(message);
const site = new URL(import.meta.env.BASE_URL, self.location.origin);

interface BundleIndex {
  file: string;
  sha256: string;
}

async function hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchBundle(): Promise<Uint8Array> {
  // The index is checked every time, so a new deploy is seen; the zip is named after the
  // upstream tag, so it can stay cached.
  const index = (await (
    await fetch(new URL('python/bundle.json', site), { cache: 'no-cache' })
  ).json()) as BundleIndex;
  const response = await fetch(new URL(`python/${index.file}`, site));
  if (!response.ok) throw new Error(`${index.file}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if ((await hex(buffer)) !== index.sha256) throw new Error(`${index.file}: wrong sha256`);
  return new Uint8Array(buffer);
}

async function start(): Promise<{ py: PyodideInterface; call: PythonCall }> {
  const t0 = performance.now();
  post({ kind: 'status', stage: 'loading-python' });
  const indexURL = new URL('pyodide/', site).href;
  const bundle = fetchBundle();
  const { loadPyodide } = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideInterface>;
  };
  const py = await loadPyodide({ indexURL });
  post({ kind: 'status', stage: 'loading-upstream' });
  const call = installUpstream(py, await bundle);
  const reply = call('info', []);
  if (!reply.ok) throw new Error(reply.error.message);
  const info: PythonInfo = {
    ...(reply.result as Omit<PythonInfo, 'pyodide' | 'startMs'>),
    pyodide: py.version,
    startMs: Math.round(performance.now() - t0),
  };
  post({ kind: 'ready', info });
  return { py, call };
}

const ready = start();
ready.catch((error: unknown) => {
  const e = error instanceof Error ? error : new Error(String(error));
  post({ kind: 'failed', error: { type: e.name, message: e.message } });
});

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  ready.then(
    ({ py, call }) => {
      const reply = handleRequest(py, call, request);
      // A file read goes back as a transferred buffer, not copied.
      const transfer =
        reply.ok && reply.result instanceof Uint8Array ? [reply.result.buffer as ArrayBuffer] : [];
      self.postMessage(
        { kind: 'reply', id: request.id, ...reply } satisfies WorkerMessage,
        transfer,
      );
    },
    (error: unknown) =>
      post({
        kind: 'reply',
        id: request.id,
        ok: false,
        error: { type: 'PythonUnavailable', message: String(error) },
      }),
  );
});
