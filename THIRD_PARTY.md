# Third-party components

Every dependency is listed here with its licence. GPL-incompatible licences are not allowed.

## Shipped in the site

| Component                                                                                 | Version                     | Licence                                                | Use                               |
| ----------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ | --------------------------------- |
| LVGL MPY Studio (`upstream/`)                                                             | the pinned tag              | GPL-3.0-or-later; generated code and runtime files MIT | Python core, runtime files, data  |
| Lit (`lit`, `lit-html`, `lit-element`, `@lit/reactive-element`, `@lit-labs/ssr-dom-shim`) | 3.3.3                       | BSD-3-Clause                                           | UI components                     |
| `@types/trusted-types`                                                                    | as locked                   | MIT                                                    | type definitions pulled in by Lit |
| Pyodide (`pyodide`), with CPython's standard library                                      | 314.0.7                     | MPL-2.0; CPython PSF-2.0                               | upstream's Python in a Web Worker |
| fflate                                                                                    | 0.8.3                       | MIT                                                    | zip import, export and bundles    |
| CodeMirror 6 (`@codemirror/*`, `@lezer/*`)                                                | as pinned in `package.json` | MIT                                                    | the code editor                   |
| xterm.js (`@xterm/xterm`, `@xterm/addon-fit`)                                             | 6.0.0, 0.11.0               | MIT                                                    | the terminal of a program         |
| opentype.js                                                                               | 1.3.4                       | MIT                                                    | the kerning of a project's fonts  |
| FreeType in WebAssembly, from lv_font_conv (`lib/freetype/build/ft_render.js`)            | lv_font_conv 1.5.3          | lv_font_conv MIT; FreeType FTL (chosen of FTL/GPL-2.0) | rasterising a project's fonts     |

FreeType's licence asks for a credit: portions of this software are copyright © The FreeType
Project (www.freetype.org). All rights reserved. The About box says it too. The FreeType Project
Licence is compatible with the GPL version 3, the IDE's licence.

### The WebAssembly runtime of the simulator

`micropython.mjs` and `micropython.wasm`, built by upstream's `runtime/build_web.sh` and taken from
the asset `lms-web-runtime-<tag>.zip` of upstream's release (`runtime.lock.json`). The site
serves their licence texts in `runtime/licenses/`, as upstream's web build does.

| Component                | Licence |
| ------------------------ | ------- |
| MicroPython              | MIT     |
| LVGL                     | MIT     |
| lvgl-bindings            | MIT     |
| lvgl-micropython         | MIT     |
| SDL2 (Emscripten's port) | Zlib    |

## Development only (not shipped)

| Component                                                        | Version         | Licence    |
| ---------------------------------------------------------------- | --------------- | ---------- |
| Vite                                                             | 8.3.5           | MIT        |
| TypeScript                                                       | 6.0.3           | Apache-2.0 |
| Vitest                                                           | 5.0.5           | MIT        |
| Playwright (`@playwright/test`)                                  | 1.64.1          | Apache-2.0 |
| ESLint, `@eslint/js`                                             | 10.14.0, 10.0.1 | MIT        |
| typescript-eslint                                                | 8.72.1          | MIT        |
| Prettier                                                         | 3.9.10          | MIT        |
| globals                                                          | 17.13.0         | MIT        |
| `@types/node`                                                    | 26.6.6          | MIT        |
| lv_font_conv (the package; only its FreeType build ships, above) | 1.5.3           | MIT        |

### Test only (Python packages loaded into Pyodide under Node)

| Component  | Version  | Licence      |
| ---------- | -------- | ------------ |
| pytest     | 9.0.2    | MIT          |
| hypothesis | 6.170.14 | MPL-2.0      |
| pyserial   | 3.5      | BSD-3-Clause |
| mpremote   | 1.29.0   | MIT          |

### Test fixtures

| Component                                                                                                         | Licence                   | Use                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------- |
| Montserrat Medium (`tests/fixtures/fonts/Montserrat-Medium.ttf`), the file LVGL ships in `scripts/built_in_font/` | SIL Open Font License 1.1 | the reference of the font converter |

The full list of transitive development packages is in `pnpm-lock.yaml`.
