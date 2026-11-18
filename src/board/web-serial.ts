// The board's serial port, held by the page with Web Serial for the whole connection (Chromium
// only). While an operation of the IDE runs, its bytes go to the Python worker, where upstream's
// DeviceSession reads them (worker-board.ts); otherwise they go to the Device Console, as on the
// desktop, where the console follows the board whenever the IDE is not using it.
import type { PythonBridge } from '../py/bridge.ts';
import type { PortInfo, SerialFromWorker } from '../py/protocol.ts';

/** The rate of every board profile: mpremote's and upstream's UartTransport's. */
export const BAUD_RATE = 115200;
/** Bytes per write, so that a long paste does not overflow the board (service.py CONSOLE_CHUNK). */
const CHUNK = 64;

/**
 * The board needs Web Serial for the port and JSPI for Python to wait for it (worker-board.ts).
 * Chromium has both; the test is on the features, not on the browser's name.
 */
export function webSerialAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serial' in navigator &&
    typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function'
  );
}

/** The ids of a USB port, which is how a port is known again after a reload. */
export function portKey(port: SerialPort): string {
  const { usbVendorId, usbProductId } = port.getInfo();
  return usbVendorId === undefined
    ? ''
    : `${usbVendorId.toString(16).padStart(4, '0')}:${(usbProductId ?? 0).toString(16).padStart(4, '0')}`;
}

export function portLabel(port: SerialPort): string {
  // the demonstration board names itself (demo-board.ts)
  const own = (port as { label?: unknown }).label;
  if (typeof own === 'string') return own;
  const key = portKey(port);
  return key ? `USB ${key}` : 'Serial port';
}

let opened = 0;

export class BoardPort {
  /** The name DeviceSession knows the port by. */
  readonly name = `webserial:${++opened}`;
  readonly label: string;
  /** The demonstration board, not hardware (demo-board.ts). */
  readonly demo: boolean;
  /** Where the bytes go: the worker during an operation, else the console. */
  private toWorker = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stopListening: () => void;
  /** Bytes for the console. */
  onConsole: (data: Uint8Array) => void = () => {};
  /** The port went away, e.g. the cable was pulled. */
  onLost: () => void = () => {};

  private constructor(
    readonly port: SerialPort,
    private readonly python: PythonBridge,
  ) {
    this.label = portLabel(port);
    this.demo = (port as { demo?: unknown }).demo === true;
    this.stopListening = python.onSerial((message) => this.fromWorker(message));
  }

  /**
   * Opens the port. The lines are left as opening sets them, as pyserial leaves them for
   * mpremote; the STM32's UART adapter wants RTS low, as UartTransport sets it.
   */
  static async open(port: SerialPort, python: PythonBridge, adapter: string): Promise<BoardPort> {
    await port.open({ baudRate: BAUD_RATE, bufferSize: 65536 });
    if (adapter === 'stm32h7_uart') {
      await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    }
    if (!port.writable) throw new Error('The port cannot be written to.');
    const board = new BoardPort(port, python);
    const info: PortInfo = { port: board.name, description: board.label };
    const { usbVendorId, usbProductId } = port.getInfo();
    if (usbVendorId !== undefined) info.vid = usbVendorId;
    if (usbProductId !== undefined) info.pid = usbProductId;
    python.serial({ kind: 'serial', op: 'open', port: board.name, info });
    board.writer = port.writable.getWriter();
    void board.read();
    return board;
  }

  private async read(): Promise<void> {
    while (!this.closed && this.port.readable) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.deliver(value);
        }
      } catch {
        // A fatal error ends the loop below; a framing error lets it read again.
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closed) this.lost();
  }

  private deliver(data: Uint8Array): void {
    if (this.toWorker) {
      const copy = new Uint8Array(data);
      this.python.serial({ kind: 'serial', op: 'data', port: this.name, data: copy }, [
        copy.buffer,
      ]);
    } else {
      this.onConsole(data);
    }
  }

  /** During an operation of the IDE the worker reads the port, otherwise the console. */
  set ideOwns(value: boolean) {
    this.toWorker = value;
  }

  get ideOwns(): boolean {
    return this.toWorker;
  }

  /** Writes in order, a few bytes at a time. */
  write(data: Uint8Array): Promise<void> {
    const writer = this.writer;
    if (!writer || this.closed) return Promise.reject(new Error('The port is closed.'));
    this.writing = this.writing.then(async () => {
      for (let offset = 0; offset < data.length; offset += CHUNK) {
        await writer.write(data.subarray(offset, offset + CHUNK));
      }
    });
    this.writing.catch(() => {});
    return this.writing;
  }

  private fromWorker(message: SerialFromWorker): void {
    if (message.kind === 'board-progress' || message.port !== this.name) return;
    if (message.kind === 'serial-write') {
      void this.write(message.data).catch(() => this.lost());
    } else {
      void this.writing
        .catch(() => {})
        .then(() => this.python.serial({ kind: 'serial', op: 'drained', id: message.id }));
    }
  }

  private lost(): void {
    if (this.closed) return;
    void this.close().then(() => this.onLost());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopListening();
    this.python.serial({ kind: 'serial', op: 'close', port: this.name });
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    try {
      await this.writing;
      this.writer?.releaseLock();
    } catch {
      // already gone
    }
    try {
      await this.port.close();
    } catch {
      // unplugged: nothing to close
    }
  }
}
