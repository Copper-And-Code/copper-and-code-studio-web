// What the simulator runs, prepared by upstream in Pyodide: the generated project (the same
// files as the goldens from host CPython) and a program's flash (build/program.py's rules).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PythonBridge } from '../../src/py/bridge.ts';
import { inProcessBridge } from './in-process.ts';
import { ROOT } from './pyodide-node.mjs';

const GOLDENS = join(ROOT, 'tests/fixtures/goldens');
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | null) => new TextDecoder().decode(data ?? new Uint8Array());

function walk(folder: string, found: string[] = []): string[] {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(relative(folder, path).split(sep).join('/'));
  }
  return found;
}

interface Prepared {
  files: string[];
  board: string;
  width: number;
  height: number;
  entry: string;
  system: string[];
}

describe('simulator preparation', () => {
  let python: PythonBridge;

  beforeAll(async () => {
    python = await inProcessBridge();
  });

  it.skipIf(!existsSync(GOLDENS))('generates the open project as upstream does', async () => {
    const project = readFileSync(join(ROOT, 'upstream/examples/snake/project.json'));
    await python.writeFile('/ws/test/snake.json', new Uint8Array(project));
    await python.call('doc_open', '/ws/test/snake.json');
    const generated = await python.call<{
      directory: string;
      files: string[];
      width: number;
      height: number;
      board: string;
    }>('sim_project');
    const expected = walk(join(GOLDENS, 'snake/py')).sort();
    expect(generated.files).toEqual(expected);
    expect([generated.width, generated.height, generated.board]).toEqual([
      1024,
      600,
      'stm32h7_core_v1_3_1024x600',
    ]);
    for (const name of expected) {
      const data = await python.readFile(`${generated.directory}/${name}`);
      expect(decode(data), name).toBe(readFileSync(join(GOLDENS, 'snake/py', name), 'utf8'));
    }
  });

  it('copies a program over its flash as an upload: same names replaced, the rest kept', async () => {
    await python.writeFile('/ws/test/prog/main.py', encode('print(1)\n'));
    await python.writeFile('/ws/test/prog/lib/util.py', encode('X = 2\n'));
    await python.writeFile('/ws/test/prog/.hidden', encode('no'));
    await python.writeFile('/ws/test/prog/__pycache__/main.mpy', encode('no'));
    await python.call('sim_reset_folder', '/sim/flash/t1');
    await python.writeFile('/sim/flash/t1/main.py', encode('old\n'));
    await python.writeFile('/sim/flash/t1/data.txt', encode('written by the program\n'));
    const prepared = await python.call<Prepared>(
      'sim_program',
      '/ws/test/prog/main.py',
      '/sim/flash/t1',
    );
    expect(prepared.files).toEqual(['data.txt', 'lib/util.py', 'main.py']);
    expect(decode(await python.readFile('/sim/flash/t1/main.py'))).toBe('print(1)\n');
    expect([prepared.board, prepared.width, prepared.height, prepared.entry]).toEqual([
      'stm32h7_core_v1_3_1024x600',
      1024,
      600,
      'main.py',
    ]);
    expect(prepared.system.map((path) => path.split('/').pop())).toEqual([
      'display_driver.py',
      'lms_sandbox.py',
      'lms_web_boot.py',
    ]);
    for (const path of prepared.system) expect(await python.readFile(path)).not.toBeNull();
  });

  it('refuses what is not a Python file, as prepare_program', async () => {
    await python.writeFile('/ws/test/prog/notes.txt', encode('text'));
    await expect(
      python.call('sim_program', '/ws/test/prog/notes.txt', '/sim/flash/t2'),
    ).rejects.toThrow('Not a Python file');
  });
});
