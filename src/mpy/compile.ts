// One compilation with mpy-cross in WebAssembly, as upstream runs the program: a fresh instance,
// the file by name, the options before it. Shared by the mpy-cross worker, the Python worker
// (the board's upload compiles its files) and the Node tests.

interface MpyCrossModule {
  FS: {
    mkdir(path: string): void;
    chdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): number;
}

export type MpyCrossFactory = (options: Record<string, unknown>) => Promise<MpyCrossModule>;

export interface Compilation {
  /** mpy-cross's exit code: 0 when the file compiled. */
  code: number;
  /** What mpy-cross printed: the errors, in upstream's format. */
  output: string;
  mpy: Uint8Array | null;
}

export async function compileOnce(
  factory: MpyCrossFactory,
  module: WebAssembly.Module,
  name: string,
  source: Uint8Array,
  args: string[],
): Promise<Compilation> {
  let output = '';
  const instance = await factory({
    print: (text: string) => (output += `${text}\n`),
    printErr: (text: string) => (output += `${text}\n`),
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance) => void,
    ) => {
      void WebAssembly.instantiate(module, imports).then(done);
      return {};
    },
  });
  instance.FS.mkdir('/work');
  instance.FS.chdir('/work');
  instance.FS.writeFile(name, source);
  // The file name relative to its folder, as upstream gives it; the heap is far larger than one
  // file needs, so that the garbage collector never runs (scripts/build-mpy-cross-web.sh).
  const code = instance.callMain(['-X', 'heapsize=64M', ...args, name]);
  let mpy: Uint8Array | null = null;
  if (code === 0) {
    try {
      mpy = instance.FS.readFile(name.replace(/\.py$/, '.mpy'));
    } catch {
      mpy = null;
    }
  }
  return { code, output, mpy };
}

/** mpy-cross from a folder of the site (public/mpy-cross/), loaded once. */
export function mpyCrossFrom(
  base: URL,
): (name: string, source: Uint8Array, args: string[]) => Promise<Compilation> {
  let loaded: Promise<{ factory: MpyCrossFactory; module: WebAssembly.Module }> | null = null;
  return async (name, source, args) => {
    if (!loaded) {
      const loading = (async () => {
        const [script, module] = await Promise.all([
          import(/* @vite-ignore */ new URL('mpy-cross.mjs', base).href) as Promise<{
            default: MpyCrossFactory;
          }>,
          WebAssembly.compileStreaming(fetch(new URL('mpy-cross.wasm', base))),
        ]);
        return { factory: script.default, module };
      })();
      // A load that failed (the network, on a first visit) is tried again at the next
      // compilation: kept, it failed every one until the page was loaded again.
      loading.catch(() => {
        if (loaded === loading) loaded = null;
      });
      loaded = loading;
    }
    const { factory, module } = await loaded;
    return compileOnce(factory, module, name, source, args);
  };
}
