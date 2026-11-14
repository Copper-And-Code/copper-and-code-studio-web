# Status: parity with the desktop IDE

Each feature of the desktop LVGL MPY Studio is **done**, **partial** (what is missing) or **not
started**. A feature is marked only as far as a test or the owner has verified it.

Upstream: the submodule in `upstream/` points to commit `a45a85f` ("Release 0.7.0"), which has
no tag yet. The About box says so until the tag exists.

## Features

| Area      | Feature                                                                               | State       |
| --------- | ------------------------------------------------------------------------------------- | ----------- |
| Project   | Open, save, save as, new project from a board profile                                 | not started |
| Project   | Unsaved-changes prompts, recent projects, settings                                    | not started |
| Project   | Workspace in the browser (OPFS), a folder of the PC (Chromium), zip import and export | not started |
| Project   | Project settings, board profile manager                                               | not started |
| Designer  | Canvas with the real LVGL rendering, zoom, resolution                                 | not started |
| Designer  | Widget tree and selection on the canvas                                               | not started |
| Designer  | Properties, with validation messages                                                  | not started |
| Designer  | Add, move, resize, delete, reparent widgets; undo and redo                            | not started |
| Designer  | Pages: add, rename, remove, adapt the resolution                                      | not started |
| Designer  | Events and handlers linked to code                                                    | not started |
| Designer  | Images                                                                                | not started |
| Designer  | Fonts                                                                                 | not started |
| Designer  | Blocks and the Block Manager                                                          | not started |
| Designer  | RAM budget                                                                            | not started |
| Code      | Generation of the project's MicroPython code (upstream `gen/` in Pyodide)             | not started |
| Code      | Code tab and Python modules: create, rename, delete, revision checks                  | not started |
| Code      | File tabs: highlighting, completion, syntax check with mpy-cross                      | not started |
| Code      | Files panel: workspace or PC folder, Run Program, Run in the Browser                  | not started |
| Simulator | Project with pages                                                                    | not started |
| Simulator | Programs without pages, console as a terminal, Ctrl-C (contract 1)                    | not started |
| Simulator | Keyboard, pointer, tones                                                              | not started |
| Board     | Connect, info, profile detection (Web Serial, Chromium only)                          | not started |
| Board     | Upload a project, Upload Files, compile to `.mpy`, the name-clash question            | not started |
| Board     | Board files: list, read, write, folder, rename, delete                                | not started |
| Board     | Run, Stop, Restart, Device Console, live update                                       | not started |
| Board     | Autostart: install and remove                                                         | not started |
| Board     | Notice in Firefox and Safari, where Web Serial is missing                             | not started |
| Web       | Publish a game for the web (zip, or a PC folder in Chromium)                          | not started |
| PWA       | Installable, works offline after the first load, update prompt                        | not started |
| UI        | Italian translation from upstream's `it.json`                                         | not started |
| UI        | Keyboard navigation, light and dark theme from the system                             | not started |

Left out by the owner's decision: the MCP server, the native C build and release packages,
printing.

## Infrastructure

| Item                                                   | State              | Checked by                                                                             |
| ------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------- |
| Empty shell with the upstream release in the About box | done               | `tests/e2e/shell.spec.ts`: Chromium and Firefox locally; WebKit in CI only (see below) |
| Lint, typecheck, unit tests                            | done               | `pnpm lint`, `pnpm typecheck`, `pnpm test` (4 tests)                                   |
| CI (`ci.yml`)                                          | written, never run | needs the GitHub repository                                                            |
| Pages deploy (`pages.yml`)                             | written, never run | runs only on the owner's request                                                       |

WebKit does not start on the development PC (Zorin OS 18.1): Playwright asks for the system
library `libavif16`. In CI `playwright install --with-deps` installs it.

## Upstream tests in Pyodide

Phase 1. Not started.
