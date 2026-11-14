# Architecture

Written as the pieces are built. Today only the shell exists.

## Pieces

| Piece                                                         | Where                                            | State       |
| ------------------------------------------------------------- | ------------------------------------------------ | ----------- |
| Shell: menu bar, panels, status bar, About box                | `src/ui/app-shell.ts`                            | empty shell |
| Build information: which upstream release this build carries  | `scripts/upstream-info.mjs`, `src/build-info.ts` | done        |
| Pyodide in a Web Worker, running upstream's core              | `src/py/`, `py/`                                 | phase 1     |
| Workspace: OPFS, a PC folder, zip                             | `src/storage/`                                   | phase 2     |
| Simulator host: sandboxed iframe with the WebAssembly runtime | `src/sim/`                                       | phase 3     |
| Board: Web Serial, raw REPL                                   | `src/board/`                                     | phase 6     |

## Rules

- Python logic comes from `upstream/`, unchanged, running in Pyodide. The TypeScript side is UI,
  browser APIs and adapters.
- Generated code always comes from upstream's `gen/`, never from TypeScript.
- The site is served under `/lvgl-mpy-studio-web/`, locally too.
