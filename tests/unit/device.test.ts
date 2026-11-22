// The board's queue (src/app/device.ts) with no board: a worker that answers from a script and a
// serial port that records what is written to it.
import { describe, expect, it } from 'vitest';
import { DeviceController, type DeviceHooks, type DeviceView } from '../../src/app/device.ts';
import { PythonBridge, type WorkerLike } from '../../src/py/bridge.ts';
import type { ProjectSession } from '../../src/project/session.ts';
import type { WorkerMessage, WorkerRequest } from '../../src/py/protocol.ts';
import { Settings } from '../../src/storage/settings.ts';

type Answer = (method: string, args: unknown[]) => unknown;

/** Every event in order: board:<method> asked of the worker, write:<text> sent to the port. */
function bench(answer: Answer) {
  const log: string[] = [];
  let listener: (event: MessageEvent<WorkerMessage>) => void = () => {};
  const reply = (id: number, work: () => unknown) =>
    void Promise.resolve()
      .then(work)
      .then(
        (result) => listener({ data: { kind: 'reply', id, ok: true, result } } as never),
        (error: unknown) =>
          listener({
            data: {
              kind: 'reply',
              id,
              ok: false,
              error: { type: 'DeviceError', message: String(error) },
            },
          } as never),
      );
  const worker: WorkerLike = {
    postMessage(request: WorkerRequest) {
      if (request.kind === 'board') {
        log.push(`board:${request.method}`);
        reply(request.id, () => answer(request.method, request.args));
      } else if (request.kind !== 'serial') {
        reply(request.id, () => null);
      }
    },
    addEventListener(type: 'message' | 'error', added: unknown) {
      if (type === 'message') listener = added as typeof listener;
    },
    terminate() {},
  };
  const state = { closed: false };
  const port = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => void log.push(`write:${new TextDecoder().decode(chunk)}`),
    }),
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    open: async () => {},
    setSignals: async () => {},
    close: async () => void (state.closed = true),
  } as unknown as SerialPort;
  const serial = { getPorts: async () => [port], requestPort: async () => port };
  const view: DeviceView = {
    append() {},
    message() {},
    setReady() {},
    setBusy() {},
    status() {},
    connection() {},
    raise() {},
    focusConsole() {},
    progress: { open() {}, report() {}, rate: () => 0, finish() {} },
  };
  const hooks: DeviceHooks = {
    appendError() {},
    addErrors() {},
    showWarnings() {},
    saveProject: async () => true,
    boardMemory() {},
    output() {},
    ask: async () => true,
    askText: async () => null,
    reloadBoardFolder() {},
    saveConfig: async () => {},
  };
  const session = { onChange: () => () => {}, state: { board: 'esp32' } };
  const device = new DeviceController(
    new PythonBridge(worker),
    session as unknown as ProjectSession,
    new Settings(null),
    view,
    hooks,
    serial as unknown as ConstructorParameters<typeof DeviceController>[5],
  );
  /** Until nothing is left to run: the replies come a few turns of the loop apart. */
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { device, hooks, log, state, settle };
}

const BOARD = { id: 'esp32', name: 'ESP32', adapter: '' };
const connects: Answer = (method) =>
  method === 'project_board' ? BOARD : method === 'connect' ? { compatible: true } : null;

describe('DeviceController', () => {
  it('fails a board file operation at once when no board is connected', async () => {
    const { device, log } = bench(connects);
    // _board_task: not kept for whichever board is connected next
    await expect(
      Promise.race([
        device.boardTask('write_file', '/main.py', ''),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
      ]),
    ).rejects.toThrow('Board not connected');
    expect(log).toEqual([]);
  });

  it('is not connected after a connection that failed', async () => {
    const { device, log, state, settle } = bench((method) => {
      if (method === 'connect') throw new Error('could not enter raw repl');
      return method === 'project_board' ? BOARD : null;
    });
    await device.connectDisconnect();
    await settle();
    expect(log).toContain('board:connect');
    // upstream's session has no port any more: neither has the IDE
    expect(device.connected).toBe(false);
    expect(state.closed).toBe(true);
  });

  it('does not start what the Files panel queued right after a program was typed', async () => {
    const { device, hooks, log, settle } = bench((method) => {
      if (method === 'upload_files')
        return { destination: '/', files: ['main.py'], bytes: 1, warnings: [] };
      if (method === 'run_line') return 'exec(open("main.py").read())';
      if (['protected_targets', 'shadowed_modules', 'list_dir'].includes(method)) return [];
      return connects(method, []);
    });
    await device.connectDisconnect();
    await settle();
    expect(device.connected).toBe(true);
    // the board's side of the Files panel reads the folder again after an upload
    hooks.reloadBoardFolder = () => void device.boardTask('list_dir', '/').catch(() => {});
    await device.uploadFiles(
      [{ name: 'main.py', read: async () => new Uint8Array([1]) }],
      '/',
      false,
      () => void device.runFileOnBoard('/main.py'),
    );
    await settle();
    const typed = log.findIndex((entry) => entry.startsWith('write:\x03exec'));
    expect(typed).toBeGreaterThan(0);
    // an operation enters the raw REPL with a Ctrl-C: the program just started would stop
    expect(log.slice(log.indexOf('board:run_line') + 1)).not.toContain('board:list_dir');
    // it runs when the board is next free
    device.stop();
    await settle();
    expect(log.slice(log.indexOf('board:stop'))).toContain('board:list_dir');
  });
});
