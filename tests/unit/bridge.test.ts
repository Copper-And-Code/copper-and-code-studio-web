import { describe, expect, it } from 'vitest';
import type { PyodideInterface } from 'pyodide';
import { PythonBridge, PythonCallError, type WorkerLike } from '../../src/py/bridge.ts';
import { handleRequest } from '../../src/py/host.ts';
import type { WorkerMessage, WorkerRequest } from '../../src/py/protocol.ts';

/** A worker that answers from a script, so the bridge is tested without Pyodide. */
class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;
  private failure: ((event: ErrorEvent) => void) | undefined;
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<WorkerMessage>) => void) | ((event: ErrorEvent) => void),
  ) {
    if (type === 'message')
      this.listener = listener as (event: MessageEvent<WorkerMessage>) => void;
    else this.failure = listener as (event: ErrorEvent) => void;
  }
  terminate() {}
  emit(message: WorkerMessage) {
    this.listener?.({ data: message } as MessageEvent<WorkerMessage>);
  }
  /** The browser's error event: a script that did not load has no message. */
  fail(message = '') {
    this.failure?.({ message } as ErrorEvent);
  }
}

const idAt = (worker: FakeWorker, index: number) => {
  const message = worker.sent.at(index);
  return message && 'id' in message ? message.id : -1;
};

const info = { upstreamVersion: '0.7.0', python: '3.14.2', pyodide: '314.0.7', startMs: 1200 };

describe('PythonBridge', () => {
  it('follows the stages of the worker until ready', async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    const stages: string[] = [];
    bridge.onState((state) => stages.push(state.stage));
    worker.emit({ kind: 'status', stage: 'loading-upstream' });
    worker.emit({ kind: 'ready', info });
    await expect(bridge.ready).resolves.toEqual(info);
    expect(stages).toEqual(['loading-python', 'loading-upstream', 'ready']);
  });

  it('matches each reply to its call, in any order', async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    const first = bridge.generate('{"a": 1}');
    const second = bridge.exportBoard('{"b": 2}', 'esp32_4848s040_480');
    expect(
      worker.sent.map((m) => (m.kind === 'call' ? [m.method, m.args] : 'op' in m ? m.op : m.kind)),
    ).toEqual([
      ['generate', ['{"a": 1}']],
      ['export_board', ['{"b": 2}', 'esp32_4848s040_480']],
    ]);
    worker.emit({ kind: 'reply', id: idAt(worker, 1), ok: true, result: 'board' });
    worker.emit({ kind: 'reply', id: idAt(worker, 0), ok: true, result: 'py' });
    await expect(first).resolves.toBe('py');
    await expect(second).resolves.toBe('board');
  });

  it("turns Python's errors into PythonCallError with type and traceback", async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    const call = bridge.generate('not json');
    worker.emit({
      kind: 'reply',
      id: idAt(worker, 0),
      ok: false,
      error: { type: 'JSONDecodeError', message: 'Expecting value', traceback: 'Traceback…' },
    });
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PythonCallError);
    expect(error).toMatchObject({ type: 'JSONDecodeError', message: 'Expecting value' });
  });

  it('reports a worker that cannot start', async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    worker.emit({ kind: 'failed', error: { type: 'Error', message: 'HTTP 404' } });
    await expect(bridge.ready).rejects.toThrow('HTTP 404');
    expect(bridge.state).toEqual({
      stage: 'failed',
      error: { type: 'Error', message: 'HTTP 404' },
    });
  });

  it('fails the start and the calls waiting when the worker itself does not load', async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    const waiting = bridge.call('set_language', 'it');
    worker.fail();
    await expect(bridge.ready).rejects.toThrow('did not load');
    await expect(waiting).rejects.toMatchObject({ type: 'WorkerError' });
    expect(bridge.state.stage).toBe('failed');
    expect(bridge.busy).toBe(0);
    // nothing is there to answer a later call either
    await expect(bridge.generate('{}')).rejects.toMatchObject({ type: 'WorkerError' });
    expect(worker.sent).toHaveLength(1);
  });

  it('keeps a ready worker after an error outside a call', async () => {
    const worker = new FakeWorker();
    const bridge = new PythonBridge(worker);
    worker.emit({ kind: 'ready', info });
    const call = bridge.generate('{}');
    worker.fail('a timer threw');
    expect(bridge.state.stage).toBe('ready');
    worker.emit({ kind: 'reply', id: idAt(worker, 0), ok: true, result: 'py' });
    await expect(call).resolves.toBe('py');
  });
});

describe('handleRequest', () => {
  it('answers a call that fails outside Python too, so the page is not left waiting', () => {
    const reply = handleRequest(
      {} as PyodideInterface,
      () => {
        throw new Error('SystemExit: 1');
      },
      { kind: 'call', id: 1, method: 'generate', args: [] },
    );
    expect(reply).toEqual({
      ok: false,
      error: { type: 'WorkerError', message: 'Error: SystemExit: 1' },
    });
  });
});
