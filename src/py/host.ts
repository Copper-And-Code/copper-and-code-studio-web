// What the Python worker does with each request, apart from starting Pyodide. Shared by the
// browser worker and the Node tests, which run it in-process.
import type { PyodideInterface } from 'pyodide';
import type { PythonCall } from './boot.ts';
import type { BridgeReply, WorkerRequest } from './protocol.ts';

export function handleRequest(
  py: PyodideInterface,
  call: PythonCall,
  request: WorkerRequest,
): BridgeReply {
  if (request.kind === 'call') return call(request.method, request.args);
  try {
    const { FS } = py;
    switch (request.op) {
      case 'write': {
        const folder = request.path.slice(0, request.path.lastIndexOf('/'));
        if (folder) FS.mkdirTree(folder);
        FS.writeFile(request.path, request.data);
        return { ok: true, result: null };
      }
      case 'read':
        return {
          ok: true,
          result: FS.analyzePath(request.path).exists ? FS.readFile(request.path) : null,
        };
      case 'folder':
        FS.mkdirTree(request.path);
        return { ok: true, result: null };
      case 'remove':
        if (FS.analyzePath(request.path).exists) FS.unlink(request.path);
        return { ok: true, result: null };
    }
  } catch (error) {
    return { ok: false, error: { type: 'FsError', message: String(error) } };
  }
}
