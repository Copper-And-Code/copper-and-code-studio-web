// The Code tab's controller on upstream's document in Pyodide: what is typed while Python answers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CodeController, type CodeState } from '../../src/app/code.ts';
import type { MpyCross } from '../../src/mpy/mpy-cross.ts';
import type { PythonBridge } from '../../src/py/bridge.ts';
import { ProjectSession, type Prompts } from '../../src/project/session.ts';
import { MemoryStore } from '../../src/storage/memory-store.ts';
import { Settings } from '../../src/storage/settings.ts';
import type { Dialogs } from '../../src/ui/dialogs.ts';
import { inProcessBridge } from './in-process.ts';
import { ROOT } from './pyodide-node.mjs';

const SNAKE = readFileSync(join(ROOT, 'upstream/examples/snake/project.json'));

const prompts: Prompts = {
  unsavedChanges: async () => 'discard',
  externalChange: async () => null,
  chooseSaveLocation: async () => null,
  confirmReplace: async () => false,
  error() {},
  status() {},
};

/** Until every call under way has been answered. */
async function settle(python: PythonBridge): Promise<void> {
  for (let quiet = 0; quiet < 3; quiet = python.busy ? 0 : quiet + 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('CodeController', () => {
  let python: PythonBridge;
  let session: ProjectSession;
  let code: CodeController;
  const output: string[] = [];

  beforeEach(async () => {
    python ??= await inProcessBridge();
    const workspace = new MemoryStore('workspace', 'Workspace');
    await workspace.write('snake.json', new Uint8Array(SNAKE));
    session = new ProjectSession(
      python,
      new Map([['workspace', workspace]]),
      prompts,
      new Settings(null),
    );
    await session.start();
    await session.open({ store: 'workspace', path: 'snake.json' });
    output.length = 0;
    code = new CodeController(
      python,
      session,
      {} as Dialogs,
      {} as MpyCross,
      (text) => output.push(text),
      () => {},
    );
    // as Studio wires them: the code is read back after a change that is not the Code tab's own
    session.onChange(() => {
      if (!code.adopting) void code.refresh();
    });
    await code.refresh();
  }, 120_000);

  /** Opens an event of a widget that has no handler yet. */
  async function openNewHandler(): Promise<void> {
    for (const object of code.objects.filter((item) => item.key.startsWith('widget:'))) {
      await code.openObject(object.key.slice(7));
      const free = code.procedures.find((procedure) => !procedure.exists);
      if (!free) continue;
      await code.openObject(object.key.slice(7), free.event);
      return;
    }
    throw new Error('snake has no event without a handler');
  }

  it('keeps a key typed while the project is read back after the first key of a new handler', async () => {
    await openNewHandler();
    expect(code.current).toMatchObject({ kind: 'handler' });
    expect(code.text()).toBe('');
    // the first key makes the handler, and the code is read back from Python: a second key typed
    // while that answer is on its way is not in it
    const call = python.call.bind(python);
    let typed = false;
    python.call = ((method: string, ...args: unknown[]) => {
      const reply = call(method, ...args);
      if (method === 'code_state' && !typed) {
        typed = true;
        code.edit('pr');
      }
      return reply;
    }) as typeof python.call;
    try {
      code.edit('p');
      await settle(python);
    } finally {
      python.call = call;
    }
    expect(typed).toBe(true);
    expect(code.text()).toBe('pr');
    const name = code.current.kind === 'handler' ? code.current.name : '';
    const state = await python.call<CodeState>('code_state');
    expect(state.handlers.find((handler) => handler.name === name)?.body).toBe('pr');
  });

  it('says that an edit did not reach the project, and sends the ones after it', async () => {
    await code.select({ kind: 'module' });
    const call = python.call.bind(python);
    let failed = false;
    python.call = ((method: string, ...args: unknown[]) => {
      if (method !== 'code_set' || failed) return call(method, ...args);
      failed = true;
      return Promise.reject(new Error('no such handler'));
    }) as typeof python.call;
    try {
      code.edit('# one\n');
      await settle(python);
      code.edit('# one two\n');
      await settle(python);
    } finally {
      python.call = call;
    }
    expect(output).toEqual(['Edit Code: no such handler\n']);
    // the chain of edits stayed rejected, and nothing typed later reached Python
    expect((await python.call<CodeState>('code_state')).module).toBe('# one two\n');
  });
});
