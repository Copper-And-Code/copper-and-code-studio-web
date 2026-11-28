// The demonstration board: a board without hardware, for showing the IDE's real flow (Connect,
// Upload, Run) where no board is at hand, and for recordings (docs/capture.md). It is the same
// MicroPython in WebAssembly as the simulator, in a sandboxed iframe (demo-frame.js), behind an
// object with the shape of a Web Serial port: BoardPort, the Python worker, mpremote and
// upstream's DeviceSession do not know it from a USB board.
import frameScript from './demo-frame.js?raw';
import { loadRuntime } from '../sim/simulator.ts';
import { language, tr } from '../i18n/tr.ts';

export type BoardFile = [path: string, data: Uint8Array];

export interface DemoConfig {
  /** The profile the board pretends to be: its id, its logical size and its firmware modules. */
  board: string;
  width: number;
  height: number;
  modules: string[];
  /** upstream's runtime/program files: display_driver.py, lms_sandbox.py. */
  system: BoardFile[];
}

export interface DemoEvents {
  /** A frame the board's display presented, RGB565 as its frame buffer. */
  frame?(rgb565: Uint8Array, width: number, height: number): void;
}

const STYLE = `
  :root { color-scheme: dark; --ratio: 1 / 1; }
  html, body { margin: 0; height: 100%; background: #101318; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas {
    display: block; max-width: 100%; max-height: 100%; aspect-ratio: var(--ratio);
    background: #000; touch-action: none; image-rendering: pixelated; outline: none;
  }
`;

function page(): string {
  return `<!DOCTYPE html>
<html lang="${language()}">
<head><meta charset="utf-8"><title>${tr('Demo board (simulated)')}</title><style>${STYLE}</style></head>
<body>
<canvas id="canvas" width="480" height="480" tabindex="0" oncontextmenu="event.preventDefault()"></canvas>
<script type="module">${frameScript}</script>
</body>
</html>`;
}

const SYNC_TIMEOUT_MS = 1000;

/** What a board's flash holds between connections, for this page's life: by profile. */
const flashes = new Map<string, BoardFile[]>();

type FrameMessage =
  | { type: 'hello' }
  | { type: 'ready' }
  | { type: 'tx'; data: Uint8Array }
  | { type: 'frame'; pixels: Uint8Array }
  | { type: 'reset'; raw: boolean; flash: BoardFile[]; pending: Uint8Array }
  | { type: 'flash'; flash: BoardFile[] | null }
  | { type: 'failed'; message: string };

/**
 * The board's serial port, with what BoardPort uses of a Web Serial SerialPort: open, readable,
 * writable, getInfo, setSignals, close.
 */
export class DemoBoard {
  /** What BoardPort shows for the port, and how it knows this is no hardware. */
  readonly label = tr('Demo board (simulated)');
  readonly demo = true;
  private iframe: HTMLIFrameElement | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private raw = false;
  private rebooted = false;
  private pending: Uint8Array = new Uint8Array();
  private closed = false;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly config: DemoConfig,
    private readonly events: DemoEvents = {},
  ) {
    window.addEventListener('message', this.onMessage);
  }

  get flash(): BoardFile[] {
    return flashes.get(this.config.board) ?? [];
  }

  getInfo(): SerialPortInfo {
    return {};
  }

  async setSignals(): Promise<void> {}

  /** Opening the port powers the board on. */
  async open(): Promise<void> {
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.iframe?.contentWindow?.postMessage({ type: 'rx', data: new Uint8Array(chunk) }, '*');
      },
    });
    this.raw = false;
    this.rebooted = false;
    this.power();
  }

  private power(): void {
    const iframe = document.createElement('iframe');
    iframe.title = tr('Demo board (simulated)');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = page();
    iframe.className = 'demo-frame';
    iframe.dataset.testid = 'demo-frame';
    this.iframe = iframe;
    this.host.replaceChildren(iframe);
  }

  private synced: (() => void) | null = null;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // what the board wrote since its last reset, kept for the next connection
    const iframe = this.iframe;
    if (iframe) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SYNC_TIMEOUT_MS);
        this.synced = () => {
          clearTimeout(timer);
          resolve();
        };
        iframe.contentWindow?.postMessage({ type: 'sync' }, '*');
      });
      this.synced = null;
    }
    try {
      this.controller?.close();
    } catch {
      // already closed
    }
    this.controller = null;
    this.iframe?.remove();
    this.iframe = null;
    this.readable = null;
    this.writable = null;
  }

  dispose(): void {
    void this.close();
    window.removeEventListener('message', this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    void this.fromFrame(event);
  };

  private async fromFrame(event: MessageEvent): Promise<void> {
    const iframe = this.iframe;
    if (!iframe || event.source !== iframe.contentWindow) return;
    const message = event.data as FrameMessage;
    switch (message.type) {
      case 'hello': {
        let runtime;
        try {
          runtime = await loadRuntime();
        } catch (error) {
          this.receive(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`);
          return;
        }
        if (this.iframe !== iframe) return;
        iframe.contentWindow?.postMessage(
          {
            type: 'start',
            mjs: runtime.mjs,
            wasm: runtime.wasm,
            width: this.config.width,
            height: this.config.height,
            board: this.config.board,
            modules: this.config.modules,
            system: this.config.system,
            flash: this.flash,
            raw: this.raw,
            rebooted: this.rebooted,
            frames: this.events.frame !== undefined,
          },
          '*',
        );
        break;
      }
      case 'ready':
        // the bytes that came after the Ctrl-D of a soft reset
        if (this.pending.length) {
          iframe.contentWindow?.postMessage({ type: 'rx', data: this.pending }, '*');
          this.pending = new Uint8Array();
        }
        break;
      case 'tx':
        this.receive(message.data);
        break;
      case 'frame':
        this.events.frame?.(message.pixels, this.config.width, this.config.height);
        break;
      case 'reset':
        // a soft reset: a new MicroPython with the same flash, as a board restarts its own
        flashes.set(this.config.board, message.flash);
        this.raw = message.raw;
        this.rebooted = true;
        this.pending = message.pending;
        this.power();
        break;
      case 'flash':
        // null: the board had not started yet, the flash kept at its last reset stands
        if (message.flash) flashes.set(this.config.board, message.flash);
        this.synced?.();
        break;
      case 'failed':
        break;
    }
  }

  private receive(data: Uint8Array | string): void {
    if (this.closed || !this.controller) return;
    this.controller.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
}
