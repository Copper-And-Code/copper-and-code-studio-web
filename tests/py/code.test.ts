// The Code tab's calls into upstream: modules with their undo, edits merged per session, and
// mpy-cross's output and tracebacks read by upstream's own parsers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PythonBridge } from '../../src/py/bridge.ts';
import type { DocState } from '../../src/project/session.ts';
import type { CodeState, MappedError } from '../../src/app/code.ts';
import { inProcessBridge } from './in-process.ts';
import { ROOT } from './pyodide-node.mjs';

const SNAKE = readFileSync(join(ROOT, 'upstream/examples/snake/project.json'));

describe('code and modules', () => {
  let python: PythonBridge;

  beforeEach(async () => {
    python ??= await inProcessBridge();
    await python.writeFile('/ws/test/snake.json', new Uint8Array(SNAKE));
    await python.call('doc_open', '/ws/test/snake.json');
  });

  it('reads mpy-cross errors as ui/files.py syntax_errors does', async () => {
    const output =
      'Traceback (most recent call last):\n  File "bad.py", line 2\nSyntaxError: invalid syntax\n';
    expect(await python.call('syntax_errors', output, '/work')).toEqual([
      { line: 2, message: 'SyntaxError: invalid syntax' },
    ]);
  });

  it('creates, renames and deletes a module, each an undo step', async () => {
    const created = await python.call<{ id: string; state: DocState }>('module_create', 'helpers');
    expect(created.state.modules).toEqual([{ id: created.id, name: 'helpers' }]);
    expect(created.state.undoText).toBe('New Module');
    const code = await python.call<CodeState>('code_state');
    expect(code.modules[0]?.source).toBe('import lvgl as lv\nimport ui\n\n\n');

    expect(await python.call('module_validate', 'helpers', null)).not.toBeNull(); // taken
    expect(await python.call('module_validate', 'helpers', created.id)).toBeNull(); // its own name
    expect(await python.call('module_validate', 'ui', null)).not.toBeNull(); // reserved

    const renamed = await python.call<{ warnings: string[]; state: DocState }>(
      'module_rename',
      'helpers',
      'tools',
    );
    expect(renamed.state.modules.map((m) => m.name)).toEqual(['tools']);
    const deleted = await python.call<{ warnings: string[]; state: DocState }>(
      'module_delete',
      'tools',
    );
    expect(deleted.state.modules).toEqual([]);
    await python.call('doc_undo');
    const back = await python.call<DocState>('doc_undo');
    expect(back.modules.map((m) => m.name)).toEqual(['helpers']);
  });

  it('merges the edits of one session into one undo step, as CodePanel does', async () => {
    await python.call('code_set', 'module', 'module', '# one\n', 7);
    await python.call('code_set', 'module', 'module', '# one two\n', 7);
    let state = await python.call<DocState>('code_set', 'module', 'module', '# one two three\n', 7);
    expect(state.modified).toBe(true);
    await python.call('code_set', 'module', 'module', '# other session\n', 8);
    await python.call<DocState>('doc_undo');
    expect((await python.call<CodeState>('code_state')).module).toBe('# one two three\n');
    state = await python.call<DocState>('doc_undo');
    expect(state.canUndo).toBe(false);
  });

  it('maps a compile error in a module to the module and its line', async () => {
    await python.call('module_create', 'helpers');
    const generated = await python.call<{ directory: string; files: string[] }>(
      'code_generate_check',
    );
    expect(generated.files).toContain('helpers.py');
    const output =
      'Traceback (most recent call last):\n  File "helpers.py", line 5\nSyntaxError: invalid syntax\n';
    const errors = await python.call<MappedError[]>('code_compile_errors', generated.directory, {
      'helpers.py': output,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ module: 'helpers', sourceLine: 5, line: 5 });
    expect(errors[0]?.message).toBe('helpers.py, line 5: SyntaxError: invalid syntax');
  });

  it('turns a traceback from the simulator into rows of the Errors panel', async () => {
    await python.call('module_create', 'helpers');
    await python.call('sim_project');
    const text =
      'Traceback (most recent call last):\n' +
      '  File "main.py", line 3, in <module>\n' +
      '  File "helpers.py", line 6, in boom\n' +
      'ValueError: boom\n';
    const rows = await python.call<MappedError[]>('code_trace_errors', text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      module: 'helpers',
      sourceLine: 6,
      origin: true,
      message: 'ValueError: boom',
    });
  });
});
