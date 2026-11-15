// The Python worker run in-process under Node: the same boot and request handling as the
// browser worker, with real Pyodide and the real bundle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installUpstream } from '../../src/py/boot.ts';
import { PythonBridge, type WorkerLike } from '../../src/py/bridge.ts';
import { handleRequest } from '../../src/py/host.ts';
import type { WorkerMessage } from '../../src/py/protocol.ts';
import { ROOT, startPyodide } from './pyodide-node.mjs';

export async function inProcessBridge(): Promise<PythonBridge> {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
    file: string;
  };
  const py = await startPyodide();
  const call = installUpstream(
    py,
    new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))),
  );
  const listeners: ((event: MessageEvent<WorkerMessage>) => void)[] = [];
  const emit = (data: WorkerMessage) => {
    for (const listener of listeners) listener({ data } as MessageEvent<WorkerMessage>);
  };
  const worker: WorkerLike = {
    postMessage(request) {
      // structuredClone, as postMessage does: the caller's buffers are never shared.
      const copy = structuredClone(request);
      if (copy.kind !== 'call' && copy.kind !== 'fs') throw new Error(`in-process: ${copy.kind}`);
      queueMicrotask(() => emit({ kind: 'reply', id: copy.id, ...handleRequest(py, call, copy) }));
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    terminate() {},
  };
  const bridge = new PythonBridge(worker);
  emit({
    kind: 'ready',
    info: { upstreamVersion: '', python: '', pyodide: py.version, startMs: 0 },
  });
  return bridge;
}
