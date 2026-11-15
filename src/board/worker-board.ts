// The board's side of the Python worker: the module lms_serial (link.ts) wired to the page's
// port through messages, and the board calls of py/lms_board.py made with stack switching, so
// that Python can wait for the board while the worker keeps answering the page.
import type { PyodideInterface } from 'pyodide';
import type { Compilation } from '../mpy/compile.ts';
import type {
  BoardRequest,
  BridgeReply,
  SerialFromWorker,
  SerialToWorker,
} from '../py/protocol.ts';
import { SerialLinks } from './link.ts';

type Post = (message: SerialFromWorker, transfer?: Transferable[]) => void;

interface PromisingCall {
  callPromising(...args: unknown[]): Promise<string>;
}

/** JSPI, which run_sync needs: in Chromium 137 and later, where Web Serial is too. */
export function stackSwitching(): boolean {
  return typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function';
}

export class WorkerBoard {
  readonly links: SerialLinks;
  private readonly drains = new Map<number, () => void>();
  private nextDrain = 1;
  private module: { call: PromisingCall; cancel: () => string } | null = null;

  constructor(
    private readonly py: PyodideInterface,
    private readonly post: Post,
    compile: (name: string, source: Uint8Array, args: string[]) => Promise<Compilation>,
  ) {
    this.links = new SerialLinks({
      compile,
      progress: (sent, total, name, size) =>
        post({ kind: 'board-progress', sent, total, name, size }),
    });
    py.registerJsModule('lms_serial', this.links.module());
  }

  private board(): { call: PromisingCall; cancel: () => string } {
    if (!this.module) {
      const module = this.py.pyimport('lms_board');
      this.module = { call: module.call as PromisingCall, cancel: module.cancel as () => string };
    }
    return this.module;
  }

  /** A message about the port. */
  serial(message: SerialToWorker): void {
    switch (message.op) {
      case 'open':
        this.links.open(message.info, {
          write: (data) =>
            this.post({ kind: 'serial-write', port: message.port, data }, [data.buffer]),
          drain: () =>
            new Promise<void>((resolve) => {
              const id = this.nextDrain++;
              this.drains.set(id, resolve);
              this.post({ kind: 'serial-drain', port: message.port, id });
            }),
        });
        break;
      case 'data':
        this.links.link(message.port)?.receive(message.data);
        break;
      case 'close':
        this.links.close(message.port);
        for (const resolve of this.drains.values()) resolve();
        this.drains.clear();
        break;
      case 'drained':
        this.drains.get(message.id)?.();
        this.drains.delete(message.id);
        break;
      case 'cancel':
        this.module?.cancel();
        break;
    }
  }

  /** One DeviceSession operation; the reply comes when the board has answered. */
  async request(request: BoardRequest): Promise<BridgeReply> {
    if (!stackSwitching()) {
      return {
        ok: false,
        error: {
          type: 'Unsupported',
          message: 'This browser cannot suspend WebAssembly (JSPI), which the board needs.',
        },
      };
    }
    try {
      const json = await this.board().call.callPromising(
        request.method,
        JSON.stringify(request.args),
      );
      return JSON.parse(json) as BridgeReply;
    } catch (error) {
      return { ok: false, error: { type: 'BoardError', message: String(error) } };
    }
  }
}
