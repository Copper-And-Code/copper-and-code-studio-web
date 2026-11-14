# Status: parity with the desktop IDE

Each feature of the desktop LVGL MPY Studio is **done**, **partial** (what is missing) or **not
started**. A feature is marked only as far as a test or the owner has verified it.

Upstream: the submodule in `upstream/` points to the tag `v0.7.0`.

## Features

| Area      | Feature                                                                               | State                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Project   | Open, save, save as, new project from a board profile                                 | not started                                                                                                                                     |
| Project   | Unsaved-changes prompts, recent projects, settings                                    | not started                                                                                                                                     |
| Project   | Workspace in the browser (OPFS), a folder of the PC (Chromium), zip import and export | not started                                                                                                                                     |
| Project   | Project settings, board profile manager                                               | not started                                                                                                                                     |
| Designer  | Canvas with the real LVGL rendering, zoom, resolution                                 | not started                                                                                                                                     |
| Designer  | Widget tree and selection on the canvas                                               | not started                                                                                                                                     |
| Designer  | Properties, with validation messages                                                  | not started                                                                                                                                     |
| Designer  | Add, move, resize, delete, reparent widgets; undo and redo                            | not started                                                                                                                                     |
| Designer  | Pages: add, rename, remove, adapt the resolution                                      | not started                                                                                                                                     |
| Designer  | Events and handlers linked to code                                                    | not started                                                                                                                                     |
| Designer  | Images                                                                                | not started                                                                                                                                     |
| Designer  | Fonts                                                                                 | not started                                                                                                                                     |
| Designer  | Blocks and the Block Manager                                                          | not started                                                                                                                                     |
| Designer  | RAM budget                                                                            | not started                                                                                                                                     |
| Code      | Generation of the project's MicroPython code (upstream `gen/` in Pyodide)             | partial: generation and board export run in the browser and match the desktop byte for byte on all 9 examples; nothing in the UI calls them yet |
| Code      | Code tab and Python modules: create, rename, delete, revision checks                  | not started                                                                                                                                     |
| Code      | File tabs: highlighting, completion, syntax check with mpy-cross                      | not started                                                                                                                                     |
| Code      | Files panel: workspace or PC folder, Run Program, Run in the Browser                  | not started                                                                                                                                     |
| Simulator | Project with pages                                                                    | not started                                                                                                                                     |
| Simulator | Programs without pages, console as a terminal, Ctrl-C (contract 1)                    | not started                                                                                                                                     |
| Simulator | Keyboard, pointer, tones                                                              | not started                                                                                                                                     |
| Board     | Connect, info, profile detection (Web Serial, Chromium only)                          | not started                                                                                                                                     |
| Board     | Upload a project, Upload Files, compile to `.mpy`, the name-clash question            | not started                                                                                                                                     |
| Board     | Board files: list, read, write, folder, rename, delete                                | not started                                                                                                                                     |
| Board     | Run, Stop, Restart, Device Console, live update                                       | not started                                                                                                                                     |
| Board     | Autostart: install and remove                                                         | not started                                                                                                                                     |
| Board     | Notice in Firefox and Safari, where Web Serial is missing                             | not started                                                                                                                                     |
| Web       | Publish a game for the web (zip, or a PC folder in Chromium)                          | not started                                                                                                                                     |
| PWA       | Installable, works offline after the first load, update prompt                        | not started                                                                                                                                     |
| UI        | Italian translation from upstream's `it.json`                                         | not started                                                                                                                                     |
| UI        | Keyboard navigation, light and dark theme from the system                             | not started                                                                                                                                     |

Left out by the owner's decision: the MCP server, the native C build and release packages,
printing.

## Infrastructure

| Item                                                   | State              | Checked by                                                                                     |
| ------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------- |
| Empty shell with the upstream release in the About box | done               | `tests/e2e/shell.spec.ts`: Chromium, Firefox and WebKit in CI; Chromium and Firefox locally    |
| Lint, typecheck, unit tests                            | done               | `pnpm lint`, `pnpm typecheck`, `pnpm test` (8 tests)                                           |
| Python in a Web Worker, ready before the UI needs it   | done               | `tests/e2e/python.spec.ts`: ready in 3.0–3.4 s with a warm cache, Chromium and Firefox locally |
| CI (`ci.yml`)                                          | done               | first run green on 2026-11-14 (run 43570952529): 4 unit tests, 3 of 3 e2e                      |
| Pages deploy (`pages.yml`)                             | written, never run | runs only on the owner's request                                                               |

WebKit does not start on the development PC (Zorin OS 18.1): Playwright asks for the system
library `libavif16`. In CI `playwright install --with-deps` installs it.

## Upstream in Pyodide

Pyodide 314.0.7 (Python 3.14.2) runs upstream's Qt-free packages unchanged, from a 168 kB
bundle. The audit of the modules is in [`pyodide-audit.md`](pyodide-audit.md).

### Generation parity

`scripts/goldens.py` runs upstream with CPython on the host for the 9 example projects:
`generate_project` for all of them, `export_board` for the 8 that name a board.
`tests/py/goldens.test.ts` (Pyodide under Node) and `tests/e2e/python.spec.ts` (the browser)
compare the web IDE's output with it: **the same files, byte for byte, and the same warnings**,
for all 9 projects and 8 board exports.

### Upstream's tests

`tests/py/upstream-tests.mjs` runs upstream's whole pytest suite in Pyodide under Node, with
upstream's dependencies apart from Qt (pyserial 3.5, mpremote 1.29.0) and its test tools
(pytest 9.0.2, hypothesis 6.170.14). On `v0.7.0`, 14 November 2026:

|                                                                 | Pyodide               | Host, CPython 3.11 without Qt |
| --------------------------------------------------------------- | --------------------- | ----------------------------- |
| passed                                                          | 634                   | 641                           |
| skipped (a native runtime, LVGL, Wine or `mpy-cross` not built) | 248                   | 248                           |
| excluded                                                        | 25 files and 34 tests |                               |
| failed outside the exclusions                                   | **0**                 |                               |

Every exclusion is listed with its reason in `tests/py/exclusions.json`:

- 25 files import PySide6 when they load (tests of the Qt UI, or core tests mixed with them:
  upstream request 4);
- 17 tests use pytest-qt's `qtbot`;
- 5 compile C with `make` and the LVGL sources, which the owner left out;
- 3 need the native `mpy-cross` or the IDE in a process, and fail on the host as well;
- 7 pass on the host and not in Pyodide, because they start a process or a thread: 4 tests of
  the serial console of `device/` (replaced here by Web Serial in phase 6), the test that starts
  a second interpreter to check that the core does not import Qt (the audit here checks it
  instead), the test of background processes, and the local HTTP server of `build/web.py`.
