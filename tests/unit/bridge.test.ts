import { describe, expect, it } from 'vitest';
import { PythonBridge, PythonCallError, type WorkerLike } from '../../src/py/bridge.ts';
import type { CallRequest, WorkerMessage } from '../../src/py/protocol.ts';

/** A worker that answers from a script, so the bridge is tested without Pyodide. */
class FakeWorker implements WorkerLike {
  sent: CallRequest[] = [];
  private listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;
  postMessage(message: CallRequest) {
    this.sent.push(message);
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void) {
    this.listener = listener;
  }
  terminate() {}
  emit(message: WorkerMessage) {
    this.listener?.({ data: message } as MessageEvent<WorkerMessage>);
  }
}

const idAt = (worker: FakeWorker, index: number) => worker.sent.at(index)?.id ?? -1;

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
    expect(worker.sent.map((m) => [m.method, m.args])).toEqual([
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
});
