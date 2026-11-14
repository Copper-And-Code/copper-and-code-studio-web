// The page's side of mpy-cross: one worker, compilations in order.
import type { CompileReply, CompileRequest } from './protocol.ts';

export interface Compiled {
  code: number;
  output: string;
  mpy: Uint8Array | null;
}

export class MpyCross {
  private worker: Worker | null = null;
  private next = 1;
  private readonly waiting = new Map<number, (reply: CompileReply) => void>();

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<CompileReply>) => {
      this.waiting.get(event.data.id)?.(event.data);
      this.waiting.delete(event.data.id);
    });
    this.worker = worker;
    return worker;
  }

  async compile(name: string, source: Uint8Array | string, args: string[] = []): Promise<Compiled> {
    const data = typeof source === 'string' ? new TextEncoder().encode(source) : source;
    const id = this.next++;
    const reply = await new Promise<CompileReply>((resolve) => {
      this.waiting.set(id, resolve);
      const request: CompileRequest = { id, name, source: data, args };
      this.start().postMessage(request);
    });
    if (!reply.ok) throw new Error(`mpy-cross: ${reply.output}`);
    return { code: reply.code, output: reply.output, mpy: reply.mpy };
  }
}
