// What the Python worker does with each request, apart from starting Pyodide. Shared by the
// browser worker and the Node tests, which run it in-process. Every request gets a reply, so the
// page is never left waiting.
import type { PyodideInterface } from 'pyodide';
import type { PythonCall } from './boot.ts';
import type { BridgeReply, CallRequest, FsRequest } from './protocol.ts';

export function handleRequest(
  py: PyodideInterface,
  call: PythonCall,
  request: CallRequest | FsRequest,
): BridgeReply {
  try {
    // Python's own failures come back as replies (lms_bridge.call); what gets past it, a
    // SystemExit or a failure of Pyodide itself, is thrown here.
    if (request.kind === 'call') return call(request.method, request.args);
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
    const type = request.kind === 'call' ? 'WorkerError' : 'FsError';
    return { ok: false, error: { type, message: String(error) } };
  }
}
