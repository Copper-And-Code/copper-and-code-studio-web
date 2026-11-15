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

## Phase 5 (2026-11-14)

Sub-gate 1, the canvas.

- **A tab per page**, as the desktop's `_sync_designers`, before Code and Simulator. The single
  Designer tab of earlier phases is gone.
- **The Real LVGL Preview is `build/preview.py`'s `render_with_log`**, with the simulator's frame
  mode in place of the native process: `prepare_page` generates the page design-only in
  Pyodide, a hidden sandboxed iframe runs it and returns the frame buffer, and a traceback or a
  frame of the wrong size counts as no frame. `ui/designer/preview.py`'s `PreviewRenderer` is
  reimplemented in `src/app/preview.ts`, because it is a Qt object with a thread: the same
  60 ms delay, only the last request kept, a page drawn again only when its `design_key`
  changes. All 20 pages of the 9 examples match the native runtime with 0 different pixels
  (`scripts/previews.py`, `tests/e2e/designer.spec.ts`), on 3 engines.
- **The previews run in their own iframe**, not in the Simulator tab's, so a preview never stops
  a running program, as on the desktop, where each preview is a process of its own.
- **The widgets on the canvas are drawn from the project, as `ui/designer/scene.py` does**: the
  position and size of `x`, `y`, `width` and `height`, inside the container. PLAN.md asks for
  the geometry from the renderer; the desktop does not read it from LVGL, so neither does the
  web IDE. Without a preview of the right size, each widget is painted as `WidgetItem.paint`
  paints it (`src/ui/designer-view.ts`, an SVG over the frame); with one, only a widget outside
  the page gets its dotted outline.
- **`ui/resolution.py`'s `board_name` is copied** into `py/lms_bridge.py`: it is three lines in a
  module that imports Qt. The resolution's dialogs are the desktop's, as a form dialog.
- **The zoom starts at 100 % and is kept per page**, as each QGraphicsView keeps its own; a new
  resolution fits the page shown again, as the manual says.
- **Start compiles the project with every edit already in Python**, and one compilation at a
  time. Before, F5 pressed right after typing could compile the text of a moment earlier, half
  a line, and the background check could rewrite the folder that Start was reading: the
  traceback test of phase 4 failed about once in four runs for this.

Sub-gate 2, the tree and the selection.

- **The tree does not follow the canvas's selection**, as on the desktop: only the canvas and the
  Properties panel do. Selecting in the tree selects on the canvas.
- **Each canvas keeps its own selection**, by widget name, as each DesignerScene does; a change
  of the project keeps the names that still exist.
- **The page actions of the Project menu come now** (Add, Rename, Delete, Set Initial Page),
  because the tree's context menu holds them. Rename moved there from a click on the page's
  name; a click now shows the page, as on the desktop.
- **The chevrons of the tree are drawn by CSS with empty alternative text**, so that each
  item's text and accessible name are its label alone.

Sub-gate 3, the Properties panel.

- **The panel's logic is ported to `py/lms_bridge.py`** (`properties_view`, `properties_set`,
  `event_handler`): `ui/properties/panel.py` holds it in a Qt widget. The checks and the
  conversions are upstream's: `validate_name`, `rename_widget`, `parse_pin`, `ensure_handler`.
- **The validation messages are the panel's, not `core/validation.py`'s.** PLAN.md names
  `core/validation.py`, but the desktop's panel does not use it: it checks the project file when
  it is loaded. The web IDE shows what the desktop shows.
- **A change to several widgets is one execute**, where the desktop opens an undo macro of one
  execute per widget: the result and the undo step are the same, without a macro in the
  temporary document of upstream request 5.
- **A value goes to the project on Enter or when the field is left**, as a delegate commits. The
  field being typed into is not rewritten by a rebuild that arrives meanwhile; after the commit
  it shows what the project holds, a refused value included.

Sub-gate 4, editing.

- **The canvas's operations are ported to `py/lms_bridge.py`** from `ui/designer/scene.py`
  (`add_widget`, `delete_selected`, `move_selected`, `commit_items`, `copy_selected`, `paste`,
  `duplicate_selected`, `align_selected`, `distribute_selected`, `change_z`), because that file
  is Qt. The pointer and the keys stay in the page (`src/ui/designer-view.ts`).
- **The workflow references for the canvas come from upstream's own `DesignerScene`**, run
  offscreen with PySide6 on the host (`scripts/workflows.py`, with the Python of a desktop
  checkout's environment), so that the port is compared with the original, not with itself.
- **"Reparent" is what the desktop does**: a widget placed on a container goes inside it, and
  a pasted widget keeps its container. The desktop has no way to move a placed widget into
  another container, so neither has the web IDE.
- **Undo and redo stay with the document**: PLAN.md names `core/actions.py`, which holds the
  code actions of the Code tab, not the undo.
- **A page is drawn again when another drawing of it is running or due**, even if its key is
  the one drawn last: upstream skips it, and a quick undo left the canvas showing the change
  undone (upstream request 7).
- **The Toolbox's drag is HTML drag and drop**, whose data cannot be read before the drop: the
  type being dragged is kept by the designer for the drop preview.

Sub-gate 5, events, blocks, budget, settings, profiles.

- **The Code tab follows `ui/code/editor.py`**: one list of what to edit is replaced by its
  Object and Procedure lists. The logic of `populate`, `_load_object`, `_load_body`,
  `_text_changed`, `ActionHelper.rebuild` and `_entries` is ported to `py/lms_bridge.py`, the
  actions themselves are upstream's `core/actions.py`. A widget's double click opens its default
  event as `open_handler` does, without making the handler: typing makes it.
- **The workflow reference of the Code tab comes from upstream's own `CodePanel`**, run offscreen
  on the host, as the canvas's comes from `DesignerScene`.
- **Upstream's `distribute_selected` takes the widgets from a set**: two at the same position come
  in a different order from one run to the next, and so does the result. The workflow picks
  widgets at different positions; the web IDE takes them in page order.
- **Upstream's configuration folder** (`platform.config_dir`: board profiles, blocks) is in
  Pyodide's file system and kept in a folder of the browser's private storage, `config`, outside
  the workspace (`src/app/managers.ts`). It is copied in at start-up and out after each change.
- **The managers' dialogs are drawn by the caller** inside the IDE's dialog element; the IDE
  shows one dialog at a time, so a question inside a manager is the browser's own `confirm`, and
  Add from Folder… closes the Block Manager, chooses, and opens it again.
- **The budget runs upstream's `measure_budget` unchanged**, with its two processes replaced:
  `compile_python` and `_bytecode_file` answer from compilations the page made first with
  mpy-cross in WebAssembly, and `_measure_ram` leaves the instrumented app to the page, which runs
  it in a hidden simulator of its own. A file already compiled with the same text is not compiled
  again, and nothing is measured while the simulator runs a program: without these the measure
  after every change slowed the rest of the IDE (and its tests).
- **The budget's tooltip says the RAM is measured in the WebAssembly simulator**: upstream's says
  "64-bit simulator", which is not true here. `ui/budget.py`'s texts are ported, because that file
  imports Qt.

Sub-gate 6, images and fonts.

- **Fonts are rasterised with lv_font_conv's FreeType** (PLAN.md 6.7, choice a): its WebAssembly
  build, rendered as lv_font_conv renders (light autohinting, the top four bits of each pixel),
  the unhinted advance as `fontconv.py` takes it. Measured on Montserrat Medium at 14, 24 and 40
  px (`tests/unit/fonts.test.ts`, references by `scripts/fonts.py` from LVGL's sources and from
  `fontconv.py` itself): the same metrics on all 95 glyphs, the same pixels but one at 40 px, and
  within upstream's own test of the glyphs LVGL ships. FreeType compiled by us (b) and Canvas 2D
  (c) were not needed.
- **Kerning adds up every pair lookup of the font's kern feature**, as HarfBuzz applies them for
  `fontconv.py`: opentype.js's `getKerningValue`, which lv_font_conv uses, reads one lookup and
  missed 333 pairs of Montserrat. Now every pair is the same as `fontconv.py`'s.
- **`lvgl_mpy_studio.fontconv` is replaced in Pyodide** by a module of `py/lms_bridge.py`: upstream's
  `gen/fonts.py` imports it to convert, and the replacement answers from the glyphs the page made,
  written by upstream's own `write_binfont`. Before every call that generates code the bridge
  converts the fonts the project asks for (`fonts_needed`, `fonts_put`), in a worker.
- **Pictures are read by the browser** (`createImageBitmap`), scaled into the screen with their
  proportions and stored as PNG, as `_read_image` does with QImage. The PNG bytes are not Qt's;
  the pixels are the same, and so is the frame the runtime draws.
- **The workflow references of pictures and fonts come from upstream's own `PropertiesPanel`** on
  the host, the file's path typed into the property as its … button does.

## Phase 6 (2026-11-15)

Sub-gate 1, the transport and the first operations.

- **Upstream's `DeviceSession` runs unchanged in Pyodide** (`py/lms_board.py`), with its own
  `runner` hook: mpremote 1.29.0, the release upstream pins, runs in-process instead of as a
  process. The scripts, checks, upload staging, `.previous` backup and error codes are
  upstream's; nothing of `device/service.py` is ported to TypeScript.
- **pyserial is replaced by `py/serial/`**, pyserial's interface over the page's port. mpremote,
  `UartTransport` (the STM32's protocol) and `break_in` use it as they are. mpremote and
  platformdirs go into the upstream bundle from `scripts/python-deps.mjs`: mpremote from PyPI,
  checked against its sha256 and against upstream's pin; platformdirs from the Pyodide package.
- **Python waits for the board with JSPI** (`pyodide.ffi.run_sync`): each board call is made with
  `callPromising`, and a read that has no bytes yet suspends Python, so the worker keeps
  receiving the port's bytes and answering the designer meanwhile (a test checks a call of the
  designer during a board call). JSPI is in every browser with Web Serial; Node 22 needs
  `--experimental-wasm-jspi` (`vitest.py.config.ts`). `time.sleep` waits the same way inside a
  board call.
- **The page holds the port open for the whole connection** (`src/board/web-serial.ts`). The
  desktop opens and closes it at every mpremote command; here mpremote's open and close are
  those of the connection only, and the lines DTR and RTS are left as opening the port sets
  them (as pyserial leaves them for mpremote), so no command can reset the board by toggling them
  (PLAN.md 6.6). The STM32's adapter gets RTS low, as `UartTransport` sets it.
- **115200 baud for every board.** PLAN.md asks for the rate of the board profile; the profiles
  have none, and upstream uses 115200 for mpremote and for `UartTransport`.
- **While an operation runs, the port's bytes go to the worker; otherwise to the Device
  Console**, as on the desktop, where the console follows the board whenever the IDE is not
  using it. `start_console`'s reader thread, which Pyodide cannot start, is the page's read loop.
- **mpy-cross in WebAssembly compiles the upload's bytecode in the Python worker**:
  `board_gen._bytecode_file` is answered with the same options (`-s name`). Its loading is shared
  with the mpy-cross worker (`src/mpy/compile.ts`).
- **The upload builds in a temporary folder**: the desktop writes `build/board/<profile>` into the
  project's folder. The files sent are the same.
- **A port is known again by its USB vendor and product ids** (`device/ports/<profile>`): Web
  Serial gives no path such as `/dev/ttyACM0`, and asks the user to choose a port the first time.
- **The board needs Web Serial and JSPI, tested as features**, not by the browser's name: the
  Firefox that Playwright runs has `navigator.serial` on localhost. Without them the Device menu
  says so in a disabled first item, and its board items are disabled.
- **The scripted board of the tests** (`tests/py/fake-board.ts`) answers as MicroPython's
  `pyexec.c` does: the friendly prompt, the raw REPL, raw-paste with its windows, soft reset, a
  firmware shell that wants Ctrl-C; the Python it receives runs in a Pyodide of its own with a
  file system in memory, MicroPython's errno numbers and its tracebacks. The e2e tests give the
  page a fake `navigator.serial` whose bytes reach that board in Node.

Sub-gate 2, the rest of the board.

- **The run target selector is a menu of the menu bar**, named after the target, as the desktop's
  toolbar button is: the web IDE has no toolbar. Its logic (`select_run_target`, the defaults
  for new projects) is ported to `py/lms_bridge.py`, because `ui/run_target.py` and
  `ui/main_window.py` are Qt.
- **The board's files are a store** (`src/board/board-store.ts`): the Files panel and the file
  tabs use it as they use the workspace, and every operation is upstream's `DeviceSession`,
  queued as `_board_task` queues it. A board file is not looked at again when the page comes
  back to the front, and not read before a save: the desktop edits a local copy that only its
  tab writes. The board is not a place of the file chooser; it has its own side of the panel.
- **`ui/device_files.py`'s pure functions are copied** into `py/lms_board.py` (`run_line`,
  `protected_targets`, `shadowed_modules`, `folder_items`' rule): their module imports Qt
  (upstream request 9).
- **Download to the Computer writes into the Files panel's folder**, as the desktop does; with a
  read-only folder or none, the browser downloads the file.
- **A soft reset before each file copied is upstream's**: `_put` runs `mpremote connect PORT fs
cp` without `resume`. The tests count it rather than hide it.
- **Autostart's backups are in the configuration folder** that the IDE keeps in the browser's
  private storage (phase 5): the transaction is upstream's, unchanged. They are in this browser
  only; another browser, or the desktop, does not know them, and removing the autostart from
  there is refused, as upstream refuses it without its manifest.
- **The scripted board can run an app**: its `lvgl` gives a permissive object for every name, so
  that a generated app starts, a live update arrives and Stop stops it, without drawing.
