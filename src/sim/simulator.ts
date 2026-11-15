// The simulator host: one sandboxed iframe per run. Start builds it, Stop drops it, so the next
// run starts clean even after a crash or a program stuck in a loop (PLAN.md 4).
import { framePage } from './frame-page.ts';
import { ToneFilter, TonePlayer } from './tones.ts';
import { tr } from '../i18n/tr.ts';

export type SimMode = 'project' | 'program' | 'frame';
export type SimFile = [path: string, data: Uint8Array];

export interface SimStart {
  mode: SimMode;
  width: number;
  height: number;
  board: string;
  /** The program's file, in its flash; unused for a project. */
  entry: string;
  /** For a program: upstream's runtime/program files that build/web.py gives it. */
  system: SimFile[];
  /** A project: the generated files. A program: its flash. */
  files: SimFile[];
}

export interface FlashChange {
  changed: SimFile[];
  removed: string[];
}

export type SimState = 'stopped' | 'starting' | 'running' | 'ended' | 'failed';

export interface SimEvents {
  output(text: string): void;
  state(state: SimState): void;
  flash?(change: FlashChange): void;
  /** machine.reset() in a program: the page reloaded itself and waits to be started again. */
  reset?(): void;
  frame?(pixels: Uint8Array | null): void;
  /** F5 or Shift+F5 pressed on the screen: the IDE's Start and Stop. */
  shortcut?(shift: boolean): void;
}

interface Runtime {
  mjs: string;
  wasm: ArrayBuffer;
}

const SYNC_TIMEOUT_MS = 300;
const RUNTIME = `${import.meta.env.BASE_URL}runtime/`;
let runtime: Promise<Runtime> | null = null;

/** The WebAssembly runtime, fetched once per page (public/runtime/, scripts/fetch-runtime.mjs). */
export function loadRuntime(base = RUNTIME): Promise<Runtime> {
  runtime ??= (async () => {
    const [mjs, wasm] = await Promise.all([
      fetch(`${base}micropython.mjs`).then((r) => {
        if (!r.ok) throw new Error(`micropython.mjs: HTTP ${r.status}`);
        return r.text();
      }),
      fetch(`${base}micropython.wasm`).then((r) => {
        if (!r.ok) throw new Error(`micropython.wasm: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]);
    return { mjs, wasm };
  })();
  runtime.catch(() => (runtime = null));
  return runtime;
}

type FrameMessage =
  | { type: 'hello' }
  | { type: 'running' }
  | { type: 'ended' }
  | { type: 'failed'; message: string }
  | { type: 'output'; data: Uint8Array }
  | { type: 'flash'; changed: SimFile[]; removed: string[] }
  | { type: 'frame'; pixels: Uint8Array | null }
  | { type: 'synced' }
  | { type: 'shortcut'; shift: boolean };

export class Simulator {
  readonly tones = new TonePlayer();
  private iframe: HTMLIFrameElement | null = null;
  private current: SimStart | null = null;
  private decoder = new TextDecoder();
  private filter = new ToneFilter((frequency, ms) => this.tones.play(frequency, ms));
  private _state: SimState = 'stopped';
  /** When the run started and when it printed or drew for the first time, for the status bar. */
  startedAt = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: SimEvents,
  ) {
    window.addEventListener('message', this.onMessage);
  }

  get state(): SimState {
    return this._state;
  }

  get running(): boolean {
    return this._state === 'starting' || this._state === 'running';
  }

  get mode(): SimMode | null {
    return this.current?.mode ?? null;
  }

  async start(start: SimStart): Promise<void> {
    await this.stop();
    this.current = start;
    this.setState('starting');
    this.startedAt = performance.now();
    this.decoder = new TextDecoder();
    this.filter = new ToneFilter((frequency, ms) => this.tones.play(frequency, ms));
    let code: Runtime;
    try {
      code = await loadRuntime();
    } catch (error) {
      this.events.output(`${error instanceof Error ? error.message : String(error)}\n`);
      this.setState('failed');
      return;
    }
    if (this.current !== start) return; // stopped meanwhile
    this.runtime = code;
    const iframe = document.createElement('iframe');
    iframe.title = tr('Simulator');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', 'autoplay');
    iframe.srcdoc = framePage();
    iframe.className = 'sim-frame';
    iframe.dataset.testid = 'sim-frame';
    this.iframe = iframe;
    this.container.replaceChildren(iframe);
  }

  private runtime: Runtime | null = null;
  private synced: (() => void) | null = null;

  /**
   * Stop: the iframe goes, and with it the program and everything it held. A program first
   * hands over what it wrote in its flash, if it answers within SYNC_TIMEOUT_MS.
   */
  async stop(): Promise<void> {
    this.tones.stop();
    const iframe = this.iframe;
    if (iframe && this.current?.mode === 'program' && this._state === 'running') {
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
    if (this.iframe === iframe && iframe) {
      iframe.remove();
      this.iframe = null;
    }
    const was = this._state;
    this.current = null;
    if (was !== 'stopped') this.setState('stopped');
  }

  /** Keys for a program's serial port: the bytes a terminal sends. */
  type(data: string): void {
    this.iframe?.contentWindow?.postMessage({ type: 'keys', data }, '*');
  }

  focus(): void {
    this.iframe?.focus();
    this.iframe?.contentWindow?.postMessage({ type: 'focus' }, '*');
  }

  /** Start again with new files, after machine.reset(): the same mode and board. */
  restartWith(files: SimFile[]): void {
    const current = this.current;
    const iframe = this.iframe;
    if (!current || !iframe || !this.runtime) return;
    this.current = { ...current, files };
    this.send(iframe, this.current, this.runtime);
  }

  private send(iframe: HTMLIFrameElement, start: SimStart, code: Runtime): void {
    iframe.contentWindow?.postMessage(
      {
        type: 'start',
        mode: start.mode,
        mjs: code.mjs,
        wasm: code.wasm,
        width: start.width,
        height: start.height,
        board: start.board,
        entry: start.entry,
        system: start.system,
        files: start.files,
      },
      '*',
    );
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const iframe = this.iframe;
    if (!iframe || event.source !== iframe.contentWindow) return;
    const message = event.data as FrameMessage;
    switch (message.type) {
      case 'hello':
        if (this._state === 'running') {
          // the page reloaded itself: machine.reset()
          this.setState('starting');
          if (this.events.reset) this.events.reset();
          else if (this.current && this.runtime) this.send(iframe, this.current, this.runtime);
        } else if (this.current && this.runtime) {
          this.send(iframe, this.current, this.runtime);
        }
        break;
      case 'running':
        this.setState('running');
        break;
      case 'output': {
        const text = this.filter.feed(this.decoder.decode(message.data, { stream: true }));
        if (text) this.events.output(text);
        break;
      }
      case 'flash':
        this.events.flash?.({ changed: message.changed, removed: message.removed });
        break;
      case 'frame':
        this.events.frame?.(message.pixels);
        break;
      case 'shortcut':
        this.events.shortcut?.(message.shift === true);
        break;
      case 'synced':
        this.synced?.();
        break;
      case 'ended':
        this.tones.stop();
        this.setState('ended');
        break;
      case 'failed':
        this.tones.stop();
        this.setState('failed');
        break;
    }
  };

  private setState(state: SimState): void {
    this._state = state;
    this.events.state(state);
  }

  dispose(): void {
    void this.stop();
    window.removeEventListener('message', this.onMessage);
  }
}
