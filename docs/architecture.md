# Architecture

Written as the pieces are built.

## Pieces

| Piece                                                         | Where                                                          | State   |
| ------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| Shell: menu bar, panels, Output, status bar, About box        | `src/ui/app-shell.ts`                                          | done    |
| Build information: which upstream release this build carries  | `scripts/upstream-info.mjs`, `src/build-info.ts`               | done    |
| Pyodide in a Web Worker, running upstream's core              | `src/py/`, `py/`                                               | done    |
| Workspace: OPFS, a PC folder, zip                             | `src/storage/`                                                 | done    |
| The open project: new, open, save, outside changes            | `src/project/session.ts`, `py/lms_document.py`                 | done    |
| Menus, dialogs, the file chooser                              | `src/ui/menu-bar.ts`, `src/ui/dialogs.ts`, `src/app/studio.ts` | done    |
| Simulator host: sandboxed iframe with the WebAssembly runtime | `src/sim/`, `src/app/run.ts`, `src/ui/sim-panel.ts`            | done    |
| Board: Web Serial, raw REPL                                   | `src/board/`                                                   | phase 6 |

## Python

```
page                                   worker (src/py/worker.ts)
PythonBridge.generate(text) ──call──►  Pyodide 314 + /lib/lms (the upstream bundle)
          ◄──reply (JSON)──            lms_bridge.call(method, json) → upstream gen/, core/
```

- `scripts/bundle-upstream.mjs` packs upstream's packages and `py/` into
  `public/python/lms-upstream-<tag>.zip`; `public/python/bundle.json` names it with its sha256, which the
  worker checks.
- `src/py/boot.ts` unpacks the bundle and opens `lms_bridge`; the worker and the Node tests use
  the same code.
- `py/lms_bridge.py` is the only Python written here: a dispatcher that calls upstream and
  returns JSON. Today: `info`, `generate`, `export_board`.
- The page starts at once and shows Python's progress in the status bar.

## Files

```
store (OPFS, PC folder, examples)  ──read──►  Pyodide FS /ws/<store>/<path>  ──►  upstream Project.load
                                   ◄─write──                                 ◄──  upstream Project.save
```

`ProjectSession` follows `ui/main_files.py`; it asks its questions through a `Prompts`
interface, which the UI answers with dialogs and the tests with a script.

## Simulator

```
IDE page                                         sandboxed iframe (opaque origin, srcdoc)
RunController ── sim_project / sim_program ──►   (Pyodide: upstream gen/, build/program.py)
Simulator ──postMessage: start {runtime, files}─►  frame.js: micropython.mjs from blob: URLs
          ──postMessage: keys ──────────────────►    lms_web_boot.py (program) or main.main()
          ◄─postMessage: output, flash, frame ───    LVGL draws on the canvas (SDL)
```

- `src/sim/simulator.ts` makes one iframe per run and drops it on Stop.
- `src/app/run.ts` follows `ui/main_run.py`: Start, Stop, Restart, Run Program…, Erase Program
  Flash…. A program's flash lives in OPFS `simulator/<key>/flash`.
- The output of a project goes to the Output panel, the output of a program to the terminal;
  tone markers are taken out and played with Web Audio (`src/sim/tones.ts`).

## Rules

- Python logic comes from `upstream/`, unchanged, running in Pyodide. The TypeScript side is UI,
  browser APIs and adapters.
- Generated code always comes from upstream's `gen/`, never from TypeScript.
- The site is served under `/lvgl-mpy-studio-web/`, locally too.
