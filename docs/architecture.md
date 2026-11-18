# Architecture

The web IDE runs upstream's Python core unchanged in Pyodide and draws the desktop's windows in
Lit components. What is written here in TypeScript is the UI, the browser's storage, the simulator's
host, Web Serial and the offline site; `docs/decisions.md` says why each piece is as it is.

## Pieces

| Piece                                                         | Where                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Shell: menu bar, panels, Output, status bar, About box        | `src/ui/app-shell.ts`, `src/ui/menu-bar.ts`                            |
| Build information: which upstream release this build carries  | `scripts/upstream-info.mjs`, `src/build-info.ts`                       |
| Pyodide in a Web Worker, running upstream's core              | `src/py/`, `py/`                                                       |
| Workspace: OPFS, a PC folder, the examples, zip               | `src/storage/`                                                         |
| The open project: new, open, save, outside changes            | `src/project/session.ts`, `py/lms_document.py`                         |
| Menus, dialogs, the file chooser                              | `src/app/studio.ts`, `src/ui/dialogs.ts`                               |
| Code editor, Code tab, file tabs                              | `src/ui/code-editor.ts`, `src/app/code.ts`, `src/app/file-tabs.ts`     |
| Simulator host: sandboxed iframe with the WebAssembly runtime | `src/sim/`, `src/app/run.ts`, `src/ui/sim-panel.ts`                    |
| Page designer: a canvas per page, Real LVGL Preview           | `src/app/designer.ts`, `src/app/preview.ts`, `src/ui/designer-view.ts` |
| Board: Web Serial, upstream's DeviceSession in Pyodide        | `src/board/`, `src/app/device.ts`, `py/lms_board.py`, `py/serial/`     |
| Web version of a game                                         | `src/app/web.ts`, `public/preview/sw.js`                               |
| Offline and installable                                       | `src/pwa/`, `scripts/sw-plugin.mjs`, `public/manifest.webmanifest`     |
| Languages                                                     | `src/i18n/`, upstream's `translations/it.json`                         |
| Capture mode for outside recorders (`docs/capture.md`)        | `src/capture/`, `src/sim/frame.js`                                     |

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
- `py/lms_bridge.py` is a dispatcher that calls upstream and returns JSON; `py/lms_document.py`
  holds the open project as upstream's `ui/document.py` does, without Qt; `py/lms_board.py` runs
  upstream's `DeviceSession`, and `py/serial/` puts Web Serial in pyserial's place.
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

## Designer

```
DesignerController ── design_page(id) ──────────►  Pyodide: the page's widgets, design_key
PreviewRenderer ──── design_preview(id) ────────►  build/preview.py prepare_page, design-only
Simulator (hidden) ──postMessage: start frame ──►  frame.js: tick 0, the first frame dumped
lms-designer-view ◄── RGB565 frame ─────────────   canvas below, the widgets as SVG above
```

- `src/app/designer.ts` follows `ui/main_window.py` and `ui/main_resolution.py`: the preview of
  the page shown, the grid, the zoom, Fit to Window, the resolution with its question.
- `src/app/preview.ts` is `ui/designer/preview.py`'s `PreviewRenderer`; its iframe is not the
  Simulator tab's.
- `src/ui/designer-view.ts` draws the page as `ui/designer/scene.py`: the frame when it has the
  project's size, otherwise each widget painted as `WidgetItem.paint`.

## Board

```
Device menu ─► DeviceController (queue) ── board(method) ──►  worker: lms_board.call, with JSPI
                                                              DeviceSession (upstream, unchanged)
                                                              └ runner: mpremote main() in-process
                                                                └ serial (py/serial/) ─ lms_serial
BoardPort (Web Serial, open) ◄── serial-write / drain ──────  SerialLink (src/board/link.ts)
          ──── bytes, while an operation runs ─────────────►
          ──── bytes, otherwise ──► Device Console
```

- A read with no bytes suspends Python (`run_sync`): the worker keeps receiving bytes and
  answering the other calls of the page.
- `src/app/device.ts` follows `ui/main_device.py`: one operation at a time, the connection opened
  when an action needs it, the upload's progress, Stop, Restart, the console, Live Editing,
  Run File on Board, Upload Files, Autostart; operations of the Files panel wait behind the
  others (`_board_task`).
- `src/board/board-store.ts` is the board as a `FileStore`, for the Files panel's board view and
  the file tabs.

## Web version

```
Run → Open in Browser ─► WebPublisher ── web_prepare ──► Pyodide: the project generated
                         mpy-cross (WebAssembly) ─► the cache
                                         ── web_build ──► build/web.py build_web, unchanged
                         ◄── the folder's files ──
   preview/<id>/ (public/preview/sw.js, Cache Storage) · zip · a folder of the PC
```

- `src/app/web.ts` follows `ui/main_files.py` `open_in_browser` and `program_in_browser`.

## Offline

```
vite build ─► dist/ ─► scripts/sw-plugin.mjs: every file + sha256 ─► dist/sw.js (src/pwa/sw.js)
page ── register, once Python is ready ──► sw.js: install = cache lms-app-<version>
                                              (a file with the same sha256 copied from the
                                               old cache, the others downloaded and checked)
     ◄── every GET of the site from the cache ──  (preview/ left to its own worker)
new deploy ─► installs beside, waits ─► status bar "Reload" ─► skip-waiting ─► reload
```

- `src/pwa/pwa.ts` registers the worker and offers the update; only in the built site.

## Rules

- Python logic comes from `upstream/`, unchanged, running in Pyodide. The TypeScript side is UI,
  browser APIs and adapters.
- Generated code always comes from upstream's `gen/`, never from TypeScript.
- The site is served under `/lvgl-mpy-studio-web/`, locally too.

## Languages

```
src/i18n/tr.ts ── tr('English text') ──► upstream it.json, then src/i18n/it-web.json ──► Italian
Settings → Language ─► applyLanguage: every Lit element renders again
                    ─► lms_bridge.set_language: upstream's own tr() in Pyodide
```

- `scripts/tr-strings.mjs` lists the texts of `src/` with the TypeScript parser;
  `tests/unit/translations.test.ts` checks each has its Italian.
