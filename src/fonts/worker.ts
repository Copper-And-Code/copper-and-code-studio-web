// The font rasteriser in a worker of its own: FreeType in WebAssembly from lv_font_conv 1.5.3,
// loaded once, and src/fonts/rasterise.ts on it.
import source from 'lv_font_conv/lib/freetype/build/ft_render.js?raw';
import { type FreeType, rasterise } from './rasterise.ts';

export interface FontRequest {
  id: number;
  data: Uint8Array;
  size: number;
  characters: string;
}

let freetype: Promise<FreeType> | null = null;

/** ft_render.js is an emscripten module written for CommonJS: it is given a module to fill. */
function load(): Promise<FreeType> {
  freetype ??= (() => {
    const holder: { exports: unknown } = { exports: {} };
    // the module is a script of a pinned package, run as CommonJS would run it
    new Function('module', 'exports', source)(holder, holder.exports);
    return (holder.exports as () => Promise<FreeType>)();
  })();
  return freetype;
}

self.addEventListener('message', (event: MessageEvent<FontRequest>) => {
  const request = event.data;
  load().then(
    (ft) => {
      try {
        const { font, missing } = rasterise(ft, request.data, request.size, request.characters);
        self.postMessage({ id: request.id, font, missing });
      } catch (error) {
        self.postMessage({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
