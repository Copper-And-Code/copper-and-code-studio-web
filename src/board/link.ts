// The serial ports as Python sees them: the JavaScript module `lms_serial` that py/serial/
// (pyserial's interface) and py/lms_board.py call into. It lives in the Python worker; the bytes
// of a port arrive with receive(), and what Python writes goes out through the port's Wire.
// The Node tests use it the same way, with a scripted board as the Wire.
import type { Compilation } from '../mpy/compile.ts';
import type { PortInfo } from '../py/protocol.ts';

/** The far end of a port: the page's Web Serial port, or a scripted board in the tests. */
export interface Wire {
  /** Queued in order; never blocks. */
  write(data: Uint8Array): void;
  /** Resolves once everything written so far has gone out. */
  drain(): Promise<void>;
}

export type { PortInfo };

/** One open port: the bytes received and not read yet, and the waiting for more. */
export class SerialLink {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private wakers: (() => void)[] = [];

  constructor(
    readonly info: PortInfo,
    private readonly wire: Wire,
  ) {}

  receive(data: Uint8Array): void {
    if (!data.length) return;
    this.chunks.push(data);
    this.size += data.length;
    this.wake();
  }

  private wake(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const waker of wakers) waker();
  }

  // ---- called from Python ----

  available(): number {
    return this.size;
  }

  take(count: number): Uint8Array {
    const out = new Uint8Array(Math.min(count, this.size));
    let filled = 0;
    while (filled < out.length) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      const part = Math.min(chunk.length, out.length - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (part === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part);
    }
    this.size -= out.length;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  /** Resolves true when bytes are there, false after ms without any. */
  wait(ms: number): Promise<boolean> {
    if (this.size) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakers = this.wakers.filter((waker) => waker !== done);
        resolve(this.size > 0);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(this.size > 0);
      };
      this.wakers.push(done);
    });
  }

  write(data: Uint8Array): void {
    // A copy: Python's buffer is released after the call.
    this.wire.write(new Uint8Array(data));
  }

  drain(): Promise<void> {
    return this.wire.drain();
  }

  /** The port went away: whoever waits finds the link gone at once. */
  lost(): void {
    this.wake();
  }
}

/** What a board call needs of the page besides the ports. */
export interface BoardHost {
  /** mpy-cross, for the upload's bytecode (board_gen._bytecode_file). */
  compile(name: string, source: Uint8Array, args: string[]): Promise<Compilation>;
  /** An upload's progress: bytes sent, all bytes, the file being written and its size. */
  progress(sent: number, total: number, name: string, size: number): void;
}

/** The module `lms_serial`, registered into Pyodide with registerJsModule. */
export class SerialLinks {
  private readonly links = new Map<string, SerialLink>();

  constructor(private readonly host: BoardHost) {}

  open(info: PortInfo, wire: Wire): SerialLink {
    this.close(info.port);
    const link = new SerialLink(info, wire);
    this.links.set(info.port, link);
    return link;
  }

  close(port: string): void {
    const link = this.links.get(port);
    if (!link) return;
    this.links.delete(port);
    link.lost();
  }

  link(port: string): SerialLink | undefined {
    return this.links.get(port);
  }

  /** The functions Python calls. */
  module(): Record<string, unknown> {
    return {
      // undefined, not null: Pyodide turns null into jsnull, undefined into None.
      get: (port: string) => this.links.get(port),
      ports: () => JSON.stringify([...this.links.values()].map((link) => link.info)),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      mpy_cross: async (
        name: string,
        source: Uint8Array,
        args: { toJs?(): string[] } | string[],
      ) => {
        const list = Array.isArray(args) ? args : (args.toJs?.() ?? []);
        const result = await this.host.compile(name, new Uint8Array(source), [...list]);
        return { code: result.code, output: result.output, mpy: result.mpy ?? undefined };
      },
      progress: (sent: number, total: number, name: string, size: number) =>
        this.host.progress(sent, total, name, size),
    };
  }
}
