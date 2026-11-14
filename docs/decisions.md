# Decision log

The owner's decisions are in `prompts/PLAN.md` §1 (kept out of the repository) and are not
repeated here. This file records the decisions taken while building, and why.

## Phase 0 (2026-11-14)

- **Upstream pin.** The owner asked for the submodule to go straight to `v0.7.0` rather than
  `v0.6.1`, because only 0.7.0 has display driver contract 1, `runtime/program/`,
  `runtime/web/program.html` and the shell example. Until the tag existed the submodule pointed to
  the commit `a45a85f` ("Release 0.7.0"). The tag, pushed the same day, is one commit later
  (`220875c`: README and a fix in `core/i18n.py` for the File menu), and the submodule now points
  to it. That fix matters here too, because the web IDE uses the same translations.
- **`prompts/` stays out of the repository**, at the owner's request. It is in `.gitignore`.
- **TypeScript 6.0.3, not 7.** typescript-eslint 8.72 accepts TypeScript below 6.1.
- **Lit without decorators.** Components use `static properties` and plain fields, so the build
  does not depend on how Vite's transpiler handles decorators.
- **One base path everywhere.** Dev, preview and the Pages build all serve the site under
  `/lvgl-mpy-studio-web/`, so a wrong path shows up locally and not only once deployed.
- **Release age enforced by pnpm.** `pnpm-workspace.yaml` sets `minimumReleaseAge` to two weeks,
  so the rule of §3.1 also holds for transitive packages. Direct dependencies are pinned
  exactly.
- **The upstream release is read at build time** by `scripts/upstream-info.mjs`: the version from
  `lvgl_mpy_studio/__init__.py`, the tag from `git describe --exact-match`. CI fetches the
  submodule's tags for this.

## Phase 1 (2026-11-14)

- **Pyodide 314.0.7**, Python 3.14.2: the newest release at least two weeks old (314.0.8 came out
  on 13 November). It is MPL-2.0. The site serves it from `public/pyodide/`, copied from the npm
  package at build time, never from a CDN. The worker loads it with a dynamic `import()` of the
  served `pyodide.mjs`, so Vite does not bundle it.
- **The bundle keeps upstream's layout** (`lvgl_mpy_studio/`, `runtime/display_driver.py`,
  `runtime/program/`), so upstream code that finds its files relative to itself works unchanged.
  It is unpacked to `/lib/lms`. It holds all of `build/`, the C parts included, because
  `build/web.py` imports `release.py` when it loads.
- **The bridge takes the project file's text** and loads it with `Project.load`, as the desktop
  does, so validation and revisions are upstream's. Files come back as text decoded from their
  bytes, without newline translation.
- **Goldens are not committed.** `pnpm goldens` writes them from the submodule into
  `tests/fixtures/goldens/` (ignored by git); CI writes them on every run. Moving the submodule
  therefore compares against the new tag at once.
- **Goldens call upstream's functions, not the CLI process.** `lvgl-mpy-studio generate` writes
  the sources and then compiles them with the native `mpy-cross`, which the submodule does not
  have. `scripts/goldens.py` calls the functions the CLI calls (`generate_project`;
  `portable_profile` and `export_board`, as `cli._board_export` does) and stops before compiling.
- **Upstream's tests run on a copy in memory.** The runner copies `upstream/` into Pyodide's
  file system, so a test can never write into the submodule. "Qt-free" means: upstream's
  dependencies apart from PySide6 and qtawesome. The host run without Qt is the reference for
  what is expected to fail anyway.
- **The bundle is served from `python/`, not `py/`.** Vite's dev server answers a request for
  `/py/…` with the page itself, because the project has a `py/` folder of its own (the glue).
  WebKit then fails on the JSON; the built site was not affected.
- **Test packages come from the network at test time**: pytest from Pyodide's package index,
  pyserial, mpremote and hypothesis from PyPI through micropip, at exact versions. They are not
  part of the site.

## Phase 2 (2026-11-14)

- **The project document is a temporary copy** of upstream's Qt-free logic, in
  `py/lms_document.py`, at the owner's choice, until upstream request 5 moves it into a module
  without Qt. It replaces `QUndoStack` with the few rules of it that `ProjectDocument` relies on:
  push, merging into the top command unless it is the clean state, undo, redo, clean index.
- **The file goes through Pyodide's file system.** Upstream reads and writes the project with
  `Path`. Before each operation that looks at the file on disk (open, save, reload), the session
  copies it from its store into Pyodide (or removes it there, if it is gone); after a save it
  copies the result back. So upstream's own revision check sees a file changed in another tab,
  or by the desktop IDE in a folder of the PC. If writing back to the store fails, the document
  goes back to unsaved (`doc_mark_unsaved`).
- **Examples are read-only**, at the owner's choice: one opens as it is, and its first Save is a
  Save As, which suggests the workspace and the same name.
- **One store interface for every place**: the workspace (OPFS), a folder of the PC (File System
  Access, Chromium), the examples (read-only, over HTTP), memory (tests, and the fallback when the
  browser refuses OPFS). OPFS and a PC folder share one implementation, as both are directory
  handles. The handles of PC folders are kept in IndexedDB.
- **The edit used to test saving is Rename Page**, the desktop's own action with its checks and
  its undo text, as the desktop has no way to change the project's name.
- **Messages are upstream's English strings** (`tr` in `src/i18n/tr.ts`), so that upstream's
  `it.json` applies to them in phase 9. The web adds a few menu items the desktop does not need
  (New for a Board, Open Example, Open a Folder of the PC, Import, Export); their strings will be
  proposed upstream then.
- **Shortcuts**: Ctrl+S, Ctrl+Shift+S, Ctrl+O, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z. Ctrl+N is not
  taken, because the browsers keep it for a new window.
- **The asset scripts synchronise their folders** (`scripts/sync-dir.mjs`) instead of deleting
  and recreating them: Vite's dev server, when its `public/` folders are recreated under it,
  answers with the page instead of the files.
- **WebKit gets a profile on disk in the e2e tests** (`tests/e2e/fixtures.ts`), because without one
  it has no OPFS; Safari has it.
- **Local e2e runs use 3 workers**: with more, the three browsers compete for the CPU and the
  start-up time measured is not the browser's.

## Phase 3 (2026-11-14)

- **The runtime comes from upstream's release**, at the owner's choice (upstream request 1):
  `runtime.lock.json` names the asset and its sha256; `scripts/fetch-runtime.mjs` downloads and
  checks it; `scripts/pack-runtime.mjs` makes it from a `runtime/build_web.sh` output. Neither
  the runtime nor Emscripten is in this repository.
- **The simulator is a sandboxed iframe without `allow-same-origin`.** A program has the `js`
  module, so with the IDE's origin it could read the workspace; with an opaque origin it reaches
  nothing of the IDE. Stop removes the iframe, so a crash or an endless loop never survives it.
  A loop that never waits still holds the browser's thread meanwhile, as upstream says for its own
  page.
- **The iframe's page is a `srcdoc` with its script inline** (`src/sim/frame.js`), and receives the
  runtime as text and bytes by `postMessage`, then loads it from `blob:` URLs. An opaque-origin frame
  cannot load module scripts from the IDE's origin without CORS headers, which static hosting does
  not always send.
- **`frame.js` reimplements upstream's two browser loaders** (`lms_web.js` for a project,
  `lms_program.js` for a program): they fetch their files by URL and print to the browser's
  console, and the IDE needs `postMessage` for both. The Python they run is upstream's, unchanged:
  `lms_web_boot.py`, `display_driver.py`, `lms_sandbox.py`, the generated project. Upstream
  request 6 would let the IDE load the loaders as they are.
- **The project runs as `.py`**, without `compile_python`: `mpy-cross` for the browser is upstream
  request 2, and the runtime imports source files. The Output panel does not claim a compilation.
- **The first frame is taken as `build/preview.py` takes it**: LVGL's tick stands still
  (`LVSIM_TICK_MS=0`), the frame buffer is written after the first complete frame
  (`LVSIM_FRAMES=1`, `LVSIM_DUMP`) and the main loop ends. The browser has no environment for
  `lvsim`, so the frame page sets the same three things on the generated `display_driver` before
  `main` runs. The references come from the native runtime (`scripts/frames.py`), and the 5
  example games match with 0 different pixels, the default threshold of upstream's visual tests.
- **A program's flash is kept in OPFS** (`simulator/<key>/flash`, the key from the place and the
  folder, as `build/program.py` keys it from the path). The folder is copied over it by
  upstream's `copy_program` in Pyodide. The frame sends what the program writes every second,
  when the page reloads for `machine.reset()`, and when Stop asks for it (up to 300 ms).
- **Tones are played by the IDE**, not by the frame: the click on Start is a user gesture of the
  IDE's page, so its `AudioContext` may play; the frame's would wait for a click on the screen.
- **The terminal takes the focus when a program starts**, as on the desktop; every key there is
  the program's, Ctrl-C and Ctrl-Z included. F5 and Shift+F5 stay the IDE's, also when the
  focus is on the screen (the frame forwards them).
- **xterm.js** (MIT) draws the terminal, with `convertEol`: a board's `print` ends lines with LF,
  and the desktop's terminal adds the CR as well.

## Phase 4 (2026-11-14)

- **mpy-cross in WebAssembly is built here**, at the owner's choice, by `scripts/build-mpy-cross-web.sh`
  (the recipe proposed for upstream request 2) from MicroPython v1.29.0 and the owner's emsdk,
  outside both checkouts. It gives the native `.mpy` bytes for 106 files and the same errors
  (`tests/py/mpy-cross.test.ts`). Its garbage collector cannot see WebAssembly locals, so each
  compilation runs in a fresh instance with a 64 MB heap, where no collection ever runs.
- **A file of the examples is copied with its whole folder into the workspace** on its first save,
  at the owner's choice, so that a program keeps its modules.
- **The browser has no file watcher**: open file tabs compare their store when the page gets the
  focus back and before saving.
- **In an editor, Ctrl+Z and Ctrl+Y are the editor's**, as in the desktop's text widgets.
- **The Code tab checks the project only while it is shown**, to keep the worker free.
