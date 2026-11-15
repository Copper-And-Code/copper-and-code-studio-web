// The web version of a game (phase 7): upstream's build/web.py in Pyodide, with mpy-cross in
// WebAssembly answering compile_python, gives the same files as on the host
// (tests/fixtures/web/files.json, from scripts/web-files.py).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileOnce, type MpyCrossFactory } from '../../src/mpy/compile.ts';
import { installUpstream } from '../../src/py/boot.ts';
import { copyIn, ROOT, startPyodide } from './pyodide-node.mjs';

const FIXTURE = join(ROOT, 'tests/fixtures/web/files.json');
type Expected = Record<string, { folder: string; files: string[] }>;

interface Reply<T> {
  ok: boolean;
  result: T;
  error?: { message: string; traceback?: string };
}

describe.skipIf(!existsSync(FIXTURE))('web version', () => {
  let py: PyodideInterface;
  let call: <T>(method: string, ...args: unknown[]) => Reply<T>;
  let compile: (name: string, source: Uint8Array, args: string[]) => ReturnType<typeof compileOnce>;
  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Expected;

  beforeAll(async () => {
    py = await startPyodide();
    const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
      file: string;
    };
    installUpstream(py, new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))));
    const bridge = py.pyimport('lms_bridge').call as (method: string, json: string) => string;
    call = <T>(method: string, ...args: unknown[]) =>
      JSON.parse(bridge(method, JSON.stringify(args))) as Reply<T>;
    const factory = (
      (await import(pathToFileURL(join(ROOT, 'public/mpy-cross/mpy-cross.mjs')).href)) as {
        default: MpyCrossFactory;
      }
    ).default;
    const wasm = await WebAssembly.compile(
      readFileSync(join(ROOT, 'public/mpy-cross/mpy-cross.wasm')),
    );
    compile = (name, source, args) => compileOnce(factory, wasm, name, source, args);
    // the runtime where build/web.py looks for it, as the page puts it there
    const runtime = call<string>('web_runtime_dir').result;
    py.FS.mkdirTree(runtime);
    for (const name of ['micropython.mjs', 'micropython.wasm']) {
      py.FS.writeFile(`${runtime}/${name}`, readFileSync(join(ROOT, 'public/runtime', name)));
    }
  }, 120_000);

  /** web_prepare, the compilations the page makes, web_build. */
  async function build(example: string) {
    copyIn(py, join(ROOT, 'upstream/examples', example), `/ws/${example}`);
    expect(call('doc_open', `/ws/${example}/project.json`).ok).toBe(true);
    const plan = call<{
      jobs: { path: string; name: string; args: string[]; key: string }[];
      cache: string;
    }>('web_prepare').result;
    for (const job of plan.jobs) {
      const result = await compile(job.name, py.FS.readFile(job.path), job.args);
      if (result.mpy) py.FS.writeFile(`${plan.cache}/${job.key}.mpy`, result.mpy);
      py.FS.writeFile(`${plan.cache}/${job.key}.out`, result.output);
    }
    return call<{ directory: string; name: string; files: string[] }>('web_build');
  }

  for (const example of ['snake', 'fifteen', 'eim-01', 'weather']) {
    it(`builds ${example} with the host's files`, async () => {
      const reply = await build(example);
      expect(reply.error?.traceback ?? '').toBe('');
      expect(reply.result.name).toBe(expected[example]?.folder);
      expect(reply.result.files).toEqual(expected[example]?.files);
      // the game is bytecode, as the native mpy-cross gives it
      const ui = py.FS.readFile(`${reply.result.directory}/game/ui.mpy`);
      expect(ui[0]).toBe(0x4d);
    }, 120_000);
  }

  it('builds a program without pages, as Run in the Browser', () => {
    copyIn(py, join(ROOT, 'upstream/examples/shell'), '/ws/shell');
    const reply = call<{ name: string; files: string[] }>('program_web', '/ws/shell/shell.py');
    expect(reply.error?.traceback ?? '').toBe('');
    expect(reply.result.name).toBe(expected['program:shell']?.folder);
    expect(reply.result.files).toEqual(expected['program:shell']?.files);
  });

  it('reports a syntax error of the project instead of building', async () => {
    copyIn(py, join(ROOT, 'upstream/examples/snake'), '/ws/broken');
    expect(call('doc_open', '/ws/broken/project.json').ok).toBe(true);
    expect(call('code_set', 'module', null, 'def broken(:\n').ok).toBe(true);
    const plan = call<{
      jobs: { path: string; name: string; args: string[]; key: string }[];
      cache: string;
    }>('web_prepare').result;
    for (const job of plan.jobs) {
      const result = await compile(job.name, py.FS.readFile(job.path), job.args);
      if (result.mpy) py.FS.writeFile(`${plan.cache}/${job.key}.mpy`, result.mpy);
      py.FS.writeFile(`${plan.cache}/${job.key}.out`, result.output);
    }
    const reply = call('web_build');
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toContain('app_events.py');
  }, 120_000);
});
