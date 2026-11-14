// mpy-cross in WebAssembly (upstream request 2's build, public/mpy-cross/) against upstream's
// native mpy-cross: the same .mpy bytes for every .py of the examples and runtime/program, and the
// same errors (tests/fixtures/mpy-cross.json, from scripts/mpy-cross-goldens.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from './pyodide-node.mjs';

interface Module {
  FS: {
    mkdir(path: string): void;
    chdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): number;
}
type Factory = (options: Record<string, unknown>) => Promise<Module>;

const goldens = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/mpy-cross.json'), 'utf8')) as {
  compiled: Record<string, string>;
  broken: Record<string, string>;
};
const BROKEN: Record<string, string> = {
  'invalid.py': 'x = 1\ndef f(:\n    pass\n',
  'indent.py': 'a = 1\n  b = 2\n',
  'unclosed.py': 'print("x"\n',
  'return.py': 'return 5\n',
  'nonlocal.py': 'def f():\n    nonlocal q\n',
};

describe('mpy-cross in WebAssembly', () => {
  let factory: Factory;
  let wasm: WebAssembly.Module;

  beforeAll(async () => {
    const script = (await import(
      pathToFileURL(join(ROOT, 'public/mpy-cross/mpy-cross.mjs')).href
    )) as { default: Factory };
    factory = script.default;
    wasm = await WebAssembly.compile(readFileSync(join(ROOT, 'public/mpy-cross/mpy-cross.wasm')));
  });

  /** As src/mpy/worker.ts runs it: a fresh instance, the file by name, a heap of 64 MB. */
  async function compile(name: string, data: Uint8Array) {
    let output = '';
    const instance = await factory({
      print: (text: string) => (output += `${text}\n`),
      printErr: (text: string) => (output += `${text}\n`),
      instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => {
        void WebAssembly.instantiate(wasm, imports).then(done);
        return {};
      },
    });
    instance.FS.mkdir('/work');
    instance.FS.chdir('/work');
    instance.FS.writeFile(name, data);
    const code = instance.callMain(['-X', 'heapsize=64M', name]);
    const mpy = code === 0 ? instance.FS.readFile(name.replace(/\.py$/, '.mpy')) : null;
    return { code, output, mpy };
  }

  it('gives the native .mpy bytes for every file, or the same error', async () => {
    const different: string[] = [];
    for (const [path, expected] of Object.entries(goldens.compiled)) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const result = await compile(name, new Uint8Array(readFileSync(join(ROOT, path))));
      const actual = result.mpy
        ? createHash('sha256').update(result.mpy).digest('hex')
        : `error: ${result.output}`;
      if (actual !== expected) different.push(path);
    }
    expect(Object.keys(goldens.compiled).length).toBeGreaterThan(20);
    expect(different).toEqual([]);
  });

  it('gives the native errors, with file and line', async () => {
    for (const [name, text] of Object.entries(BROKEN)) {
      const result = await compile(name, new TextEncoder().encode(text));
      expect(result.code, name).toBe(1);
      expect(result.output, name).toBe(goldens.broken[name]);
    }
  });
});
