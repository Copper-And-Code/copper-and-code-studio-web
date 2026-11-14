# Architecture

Written as the pieces are built. Today only the shell exists.

## Pieces

| Piece                                                         | Where                                            | State       |
| ------------------------------------------------------------- | ------------------------------------------------ | ----------- |
| Shell: menu bar, panels, status bar, About box                | `src/ui/app-shell.ts`                            | empty shell |
| Build information: which upstream release this build carries  | `scripts/upstream-info.mjs`, `src/build-info.ts` | done        |
| Pyodide in a Web Worker, running upstream's core              | `src/py/`, `py/`                                 | done        |
| Workspace: OPFS, a PC folder, zip                             | `src/storage/`                                   | phase 2     |
| Simulator host: sandboxed iframe with the WebAssembly runtime | `src/sim/`                                       | phase 3     |
| Board: Web Serial, raw REPL                                   | `src/board/`                                     | phase 6     |

## Python

```
page                                   worker (src/py/worker.ts)
PythonBridge.generate(text) ──call──►  Pyodide 314 + /lib/lms (the upstream bundle)
          ◄──reply (JSON)──            lms_bridge.call(method, json) → upstream gen/, core/
```

- `scripts/bundle-upstream.mjs` packs upstream's packages and `py/` into
  `public/py/lms-upstream-<tag>.zip`; `public/py/bundle.json` names it with its sha256, which the
  worker checks.
- `src/py/boot.ts` unpacks the bundle and opens `lms_bridge`; the worker and the Node tests use
  the same code.
- `py/lms_bridge.py` is the only Python written here: a dispatcher that calls upstream and
  returns JSON. Today: `info`, `generate`, `export_board`.
- The page starts at once and shows Python's progress in the status bar.

## Rules

- Python logic comes from `upstream/`, unchanged, running in Pyodide. The TypeScript side is UI,
  browser APIs and adapters.
- Generated code always comes from upstream's `gen/`, never from TypeScript.
- The site is served under `/lvgl-mpy-studio-web/`, locally too.
