// The fonts of a project, converted before Python generates code: upstream's fontconv.py is Qt,
// so py/lms_bridge.py asks the page (fonts_needed), and the page answers (fonts_put) with the
// glyphs of src/fonts/rasterise.ts, rasterised in a worker.
import type { PythonBridge } from '../py/bridge.ts';
import type { RasterFont } from './rasterise.ts';

interface Needed {
  key: string;
  path: string;
  size: number;
  characters: string;
}

type Reply = { id: number; font?: RasterFont; missing?: string; error?: string };

/**
 * The calls that generate code, and so may convert fonts: of the bridge, and of the board
 * (upload, live_send). One left out generates with Montserrat in place of the project's font.
 */
export const GENERATING = new Set([
  'generate',
  'export_board',
  'doc_generate',
  'sim_project',
  'design_preview',
  'code_generate_check',
  'budget_prepare',
  'budget_measure',
  'web_prepare',
  'web_build',
  'upload',
  'live_send',
]);

export class FontConverter {
  private worker: Worker | null = null;
  private next = 1;
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly python: PythonBridge) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<Reply>) => {
      this.waiting.get(event.data.id)?.(event.data);
      this.waiting.delete(event.data.id);
    });
    // A worker that does not load answers nothing, and every call that generates code waits for
    // the fonts: the fonts asked fail now, with the reason, and the next one starts a new worker.
    worker.addEventListener('error', (event: ErrorEvent) => {
      if (this.worker !== worker) return;
      this.worker = null;
      worker.terminate();
      const error = event.message || 'the worker did not load';
      for (const [id, answer] of [...this.waiting]) {
        this.waiting.delete(id);
        answer({ id, error });
      }
    });
    this.worker = worker;
    return worker;
  }

  private rasterise(data: Uint8Array, size: number, characters: string): Promise<Reply> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.start().postMessage({ id, data, size, characters });
    });
  }

  /** Every font the project needs, converted; one run at a time. */
  ensure(): Promise<void> {
    this.running = this.running.then(
      () => this.convert(),
      () => this.convert(),
    );
    return this.running;
  }

  private async convert(): Promise<void> {
    const needed = await this.python.call<Needed[]>('fonts_needed');
    for (const request of needed) {
      const data = await this.python.readFile(request.path);
      if (!data) continue;
      const reply = await this.rasterise(data, request.size, request.characters);
      await this.python.call(
        'fonts_put',
        request.key,
        reply.font ?? null,
        reply.missing ?? '',
        reply.error ?? null,
      );
    }
  }
}
