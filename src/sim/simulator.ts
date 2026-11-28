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
  /** Capture mode (docs/capture.md): frames out, a clock by steps, a fixed seed. */
  capture?: SimCapture | null;
}

export interface SimCapture {
  /** Every frame the program presents goes to SimEvents.captureFrame. */
  frames: boolean;
  /** manual: a project's clock moves only with step(ms). */
  clock: 'real' | 'manual';
  seed: number | null;
}

export interface FlashChange {
  changed: SimFile[];
  removed: string[];
}

export type SimState = 'stopped' | 'starting' | 'running' | 'ended' | 'failed';

export interface SimOptions {
  /**
   * Runs of this mode find a frame whose runtime is already loaded: one is made ready after each
   * run, for the next. For the designer's preview, which draws a page at every change: each
   * drawing would otherwise wait for MicroPython to be compiled and started again.
   */
  warm?: SimMode;
  /** The name the tests find the frame by: only the simulator in sight has one. */
  testid?: string;
}

export interface SimEvents {
  output(text: string): void;
  state(state: SimState): void;
  flash?(change: FlashChange): void;
  /** machine.reset() in a program: the page reloaded itself and waits to be started again. */
  reset?(): void;
  frame?(pixels: Uint8Array | null): void;
  /** F5 or Shift+F5 pressed on the screen: the IDE's Start and Stop. */
  shortcut?(shift: boolean): void;
  /** Capture mode: a frame the program presented, RGB565 as the runtime's frame buffer. */
  captureFrame?(frame: { number: number; width: number; height: number; rgb565: Uint8Array }): void;
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
  | { type: 'warmed' }
  | { type: 'running' }
  | { type: 'ended' }
  | { type: 'failed'; message: string }
  | { type: 'output'; data: Uint8Array }
  | { type: 'flash'; changed: SimFile[]; removed: string[] }
  | { type: 'frame'; pixels: Uint8Array | null }
  | { type: 'synced' }
  | { type: 'capture-frame'; number: number; pixels: Uint8Array }
  | { type: 'stepped'; now: number; frame: number }
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
  /** With `warm`: the frame made ready for the next run, and the frames whose runtime is loaded. */
  private spare: HTMLIFrameElement | null = null;
  private readonly warmed = new WeakSet<HTMLIFrameElement>();
  private sparing: ReturnType<typeof setTimeout> | undefined;
  /** How many runs found their runtime already loaded: for the tests. */
  warmStarts = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: SimEvents,
    private readonly options: SimOptions = {},
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
    const spare = this.options.warm === start.mode ? this.spare : null;
    if (spare) {
      // the frame made ready after the last run: its files now, or as soon as it says `warmed`
      clearTimeout(this.sparing);
      this.spare = null;
      this.iframe = spare;
      if (this.warmed.has(spare)) {
        this.warmStarts++;
        this.send(spare, start, null);
      }
      return;
    }
    const iframe = this.frame();
    this.iframe = iframe;
    // with a spare frame the container holds two: nothing else is in it
    if (this.options.warm) this.container.append(iframe);
    else this.container.replaceChildren(iframe);
  }

  private frame(): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    iframe.title = tr('Simulator');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', 'autoplay');
    iframe.srcdoc = framePage();
    iframe.className = 'sim-frame';
    if (this.options.testid) iframe.dataset.testid = this.options.testid;
    return iframe;
  }

  /** With `warm`: a frame for the next run, made once this one has left the page alone. */
  private spareLater(): void {
    if (!this.options.warm || this.spare || !this.runtime) return;
    clearTimeout(this.sparing);
    this.sparing = setTimeout(() => {
      if (this.spare || !this.runtime) return;
      this.spare = this.frame();
      this.container.append(this.spare);
    }, 0);
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
    this.spareLater();
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

  /** code is null for a frame that has its runtime already (`warmed`). */
  private send(iframe: HTMLIFrameElement, start: SimStart, code: Runtime | null): void {
    iframe.contentWindow?.postMessage(
      {
        type: 'start',
        mode: start.mode,
        mjs: code?.mjs,
        wasm: code?.wasm,
        width: start.width,
        height: start.height,
        board: start.board,
        entry: start.entry,
        system: start.system,
        files: start.files,
        capture: start.capture ?? null,
      },
      '*',
    );
  }

  private stepWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;

  /**
   * Capture mode with the manual clock: the project's clock moves by ms, LVGL runs once, and the
   * promise resolves when the main loop is back at its poll, with the step's frames sent.
   */
  step(ms: number): Promise<void> {
    const iframe = this.iframe;
    if (!iframe || this.current?.mode !== 'project' || this.current.capture?.clock !== 'manual')
      return Promise.reject(new Error('step: no project runs with the manual clock'));
    if (this.stepWaiter) return Promise.reject(new Error('step: the previous step has not ended'));
    if (this._state === 'ended' || this._state === 'failed')
      return Promise.reject(new Error(`step: the simulator has ${this._state}`));
    return new Promise<void>((resolve, reject) => {
      this.stepWaiter = { resolve, reject };
      iframe.contentWindow?.postMessage({ type: 'step', ms }, '*');
    });
  }

  /** Capture mode with the manual clock: the pointer from the next step on, in display pixels. */
  pointer(x: number, y: number, pressed: boolean): void {
    this.iframe?.contentWindow?.postMessage({ type: 'pointer', pointer: [x, y, pressed] }, '*');
  }

  private endStep(error: Error | null): void {
    const waiter = this.stepWaiter;
    this.stepWaiter = null;
    if (!waiter) return;
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const from = [this.iframe, this.spare].find(
      (frame) => frame && event.source === frame.contentWindow,
    );
    if (!from) return;
    const message = event.data as FrameMessage;
    if (this.options.warm && this.runtime) {
      if (message.type === 'hello' && !this.warmed.has(from)) {
        // its runtime first; the files when there is something to run
        from.contentWindow?.postMessage(
          {
            type: 'warm',
            mode: this.options.warm,
            mjs: this.runtime.mjs,
            wasm: this.runtime.wasm,
          },
          '*',
        );
        return;
      }
      if (message.type === 'warmed') {
        this.warmed.add(from);
        if (from === this.iframe && this.current) this.send(from, this.current, null);
        return;
      }
    }
    if (from !== this.iframe) {
      // the spare frame: one that cannot load its runtime is dropped, and the next run makes its own
      if (message.type === 'failed') {
        from.remove();
        this.spare = null;
      }
      return;
    }
    const iframe = from;
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
      case 'capture-frame':
        if (this.current)
          this.events.captureFrame?.({
            number: message.number,
            width: this.current.width,
            height: this.current.height,
            rgb565: message.pixels,
          });
        break;
      case 'stepped':
        this.endStep(null);
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
    if (state !== 'running' && state !== 'starting')
      this.endStep(new Error(`step: the simulator has ${state}`));
    this.events.state(state);
  }

  dispose(): void {
    void this.stop();
    clearTimeout(this.sparing);
    this.spare?.remove();
    this.spare = null;
    window.removeEventListener('message', this.onMessage);
  }
}
