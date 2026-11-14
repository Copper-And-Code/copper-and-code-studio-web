// Puts upstream's Python into a running Pyodide and opens the bridge. Shared by the browser
// worker (worker.ts) and the Node tests, so both run the same bundle the same way.
import type { PyodideInterface } from 'pyodide';
import type { BridgeReply } from './protocol.ts';

/** Where the bundle is unpacked: upstream's layout, so its own relative paths still work. */
export const LMS_DIR = '/lib/lms';

export type PythonCall = (method: string, args: unknown[]) => BridgeReply;

export function installUpstream(py: PyodideInterface, zip: Uint8Array): PythonCall {
  py.unpackArchive(zip, 'zip', { extractDir: LMS_DIR });
  py.runPython(
    `import sys\nif ${JSON.stringify(LMS_DIR)} not in sys.path:\n    sys.path.insert(0, ${JSON.stringify(LMS_DIR)})\nimport lms_bridge`,
  );
  const bridge = py.pyimport('lms_bridge');
  const call = bridge.call as (method: string, json: string) => string;
  return (method, args) => JSON.parse(call(method, JSON.stringify(args))) as BridgeReply;
}
