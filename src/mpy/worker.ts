// mpy-cross in WebAssembly, in a worker of its own: upstream request 2's build, from the asset in
// public/mpy-cross/. The module is compiled once; each compilation gets a fresh instance, so its
// memory is freed at the end (scripts/build-mpy-cross-web.sh says why that matters).
import { mpyCrossFrom } from './compile.ts';
import type { CompileReply, CompileRequest } from './protocol.ts';

const compile = mpyCrossFrom(
  new URL('mpy-cross/', new URL(import.meta.env.BASE_URL, self.location.origin)),
);

self.addEventListener('message', (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  compile(request.name, request.source, request.args).then(
    (result) =>
      self.postMessage(
        { id: request.id, ok: true, ...result } satisfies CompileReply,
        result.mpy ? [result.mpy.buffer] : [],
      ),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        code: -1,
        output: error instanceof Error ? error.message : String(error),
        mpy: null,
      } satisfies CompileReply),
  );
});
