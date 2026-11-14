// The designer's Real LVGL Preview, as upstream's ui/designer/preview.py PreviewRenderer: the page
// drawn by the runtime in the background, only the last request kept, a page drawn again only
// when what it shows changed (build/preview.py design_key). The drawing is build/preview.py's
// render_with_log, with the simulator's frame mode in place of the native process.
import type { PythonBridge } from '../py/bridge.ts';
import { type SimFile, type SimState, Simulator } from '../sim/simulator.ts';

const DELAY_MS = 60; // ui/designer/preview.py DELAY_MS
const RENDER_TIMEOUT_MS = 5000; // build/preview.py RENDER_TIMEOUT

/** Geometries of a drag not recorded yet: widget id → x, y, width, height. */
export type PendingGeometry = Record<
  string,
  { x: number; y: number; width: number; height: number }
>;

export interface Preview {
  pageId: string;
  /** RGB565, little-endian, as the runtime's frame buffer; null when the page could not be drawn. */
  pixels: Uint8Array | null;
  width: number;
  height: number;
  /** What the runtime printed: the reason when there are no pixels. */
  log: string;
  /** The design_key of what was drawn; null when Python could not prepare the page. */
  key: string | null;
}

interface Request {
  pageId: string;
  pending: PendingGeometry | null;
}

interface Prepared {
  directory?: string;
  files?: string[];
  width?: number;
  height?: number;
  board?: string;
  key: string;
  error?: string;
}

export class PreviewRenderer {
  private request_: Request | null = null;
  private running = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly done = new Map<string, string>();
  private readonly listeners = new Set<(preview: Preview) => void>();
  private simulator: Simulator | null = null;
  private log = '';
  private settle: ((pixels: Uint8Array | null) => void) | null = null;

  constructor(
    private readonly python: PythonBridge,
    private readonly host: HTMLElement,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  onRendered(listener: (preview: Preview) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A page to draw; key is its design_key, the page is skipped if already drawn so. */
  request(pageId: string, key: string, pending: PendingGeometry | null = null): boolean {
    if (!pending && this.done.get(pageId) === key) return false;
    this.request_ = { pageId, pending };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.start(), pending ? 0 : DELAY_MS);
    return true;
  }

  stop(): void {
    clearTimeout(this.timer);
    this.dirty = false;
  }

  /** Every page is drawn again at the next request: the preview was turned off and on. */
  forget(): void {
    this.done.clear();
  }

  private async start(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return;
    }
    const request = this.request_;
    if (!request) return;
    this.running = true;
    let preview: Preview;
    let key: string | null = null;
    try {
      const prepared = await this.python.call<Prepared>(
        'design_preview',
        request.pageId,
        request.pending,
      );
      key = prepared.key;
      preview = await this.render(request.pageId, prepared);
    } catch (error) {
      preview = {
        pageId: request.pageId,
        pixels: null,
        width: 0,
        height: 0,
        log: error instanceof Error ? error.message : String(error),
        key: null,
      };
    }
    // a drag's frame is not the page as recorded: it does not count as drawn
    if (preview.pixels && key !== null && !request.pending) this.done.set(request.pageId, key);
    for (const listener of this.listeners) listener(preview);
    this.running = false;
    if (this.dirty) {
      this.dirty = false;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.start(), DELAY_MS);
    }
  }

  /** render_with_log: the generated page in the runtime, its first frame, or why not. */
  private async render(pageId: string, prepared: Prepared): Promise<Preview> {
    const width = prepared.width ?? 0;
    const height = prepared.height ?? 0;
    const key = prepared.key;
    const failed = (log: string): Preview => ({ pageId, pixels: null, width, height, log, key });
    if (prepared.error || !prepared.directory || !prepared.files) {
      return failed(prepared.error ?? '');
    }
    const files: SimFile[] = [];
    for (const name of prepared.files) {
      const data = await this.python.readFile(`${prepared.directory}/${name}`);
      if (data) files.push([name, data]);
    }
    const simulator = this.ensureSimulator();
    this.log = '';
    const pixels = new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.log ||= 'the runtime did not draw a frame in time';
        resolve(null);
      }, RENDER_TIMEOUT_MS);
      this.settle = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    await simulator.start({
      mode: 'frame',
      width,
      height,
      board: prepared.board ?? 'simulator',
      entry: 'main.py',
      system: [],
      files,
    });
    const result = await pixels;
    this.settle = null;
    await simulator.stop();
    const log = this.log;
    // the frame of an app that raised an error does not count
    if (log.includes('Traceback (most recent call last)')) return failed(log);
    if (!result || result.length !== width * height * 2) return failed(log);
    return { pageId, pixels: result, width, height, log, key };
  }

  private ensureSimulator(): Simulator {
    this.simulator ??= new Simulator(this.host, {
      output: (text) => (this.log += text),
      state: (state: SimState) => {
        if (state === 'failed' || state === 'ended') this.settle?.(null);
      },
      frame: (pixels) => this.settle?.(pixels),
    });
    return this.simulator;
  }

  dispose(): void {
    this.stop();
    this.simulator?.dispose();
  }
}

/** The RGB565 frame as RGBA for a canvas: build/visual.py rgb565_to_rgb, with opaque alpha. */
export function rgb565ToRgba(pixels: Uint8Array, width: number, height: number): ImageData {
  const image = new ImageData(width, height);
  const data = image.data;
  for (let index = 0; index < width * height; index++) {
    const value = ((pixels[index * 2 + 1] ?? 0) << 8) | (pixels[index * 2] ?? 0);
    const red = value >> 11;
    const green = (value >> 5) & 0x3f;
    const blue = value & 0x1f;
    const target = index * 4;
    data[target] = (red << 3) | (red >> 2);
    data[target + 1] = (green << 2) | (green >> 4);
    data[target + 2] = (blue << 3) | (blue >> 2);
    data[target + 3] = 255;
  }
  return image;
}
