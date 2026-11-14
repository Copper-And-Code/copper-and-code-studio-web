// mpy-cross in WebAssembly, in a worker of its own: upstream request 2's build, from the asset in
// public/mpy-cross/. The module is compiled once; each compilation gets a fresh instance, so its
// memory is freed at the end (scripts/build-mpy-cross-web.sh says why that matters).
import type { CompileReply, CompileRequest } from './protocol.ts';

interface MpyCrossModule {
  FS: {
    mkdir(path: string): void;
    chdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): number;
}
type Factory = (options: Record<string, unknown>) => Promise<MpyCrossModule>;

const BASE = new URL('mpy-cross/', new URL(import.meta.env.BASE_URL, self.location.origin));
let loaded: Promise<{ factory: Factory; module: WebAssembly.Module }> | null = null;

function load() {
  loaded ??= (async () => {
    const [script, module] = await Promise.all([
      import(/* @vite-ignore */ new URL('mpy-cross.mjs', BASE).href) as Promise<{
        default: Factory;
      }>,
      WebAssembly.compileStreaming(fetch(new URL('mpy-cross.wasm', BASE))),
    ]);
    return { factory: script.default, module };
  })();
  return loaded;
}

async function compile(request: CompileRequest): Promise<CompileReply> {
  const { factory, module } = await load();
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
  instance.FS.writeFile(request.name, request.source);
  // As upstream calls it: the file name relative to its folder; the heap is far larger than one
  // file needs, so that the garbage collector never runs.
  const code = instance.callMain(['-X', 'heapsize=64M', ...request.args, request.name]);
  let mpy: Uint8Array | null = null;
  if (code === 0) {
    try {
      mpy = instance.FS.readFile(request.name.replace(/\.py$/, '.mpy'));
    } catch {
      mpy = null;
    }
  }
  return { id: request.id, ok: true, code, output, mpy };
}

self.addEventListener('message', (event: MessageEvent<CompileRequest>) => {
  compile(event.data).then(
    (reply) => self.postMessage(reply, reply.mpy ? [reply.mpy.buffer] : []),
    (error: unknown) =>
      self.postMessage({
        id: event.data.id,
        ok: false,
        code: -1,
        output: error instanceof Error ? error.message : String(error),
        mpy: null,
      } satisfies CompileReply),
  );
});
