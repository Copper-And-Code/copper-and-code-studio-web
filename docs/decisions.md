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
  changes. All 20 pages of the 8 examples match the native runtime with 0 different pixels
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
- **The gate on a real board is split in two**: here, the IDE's board stack runs from Node on a
  serial port of the PC (`tests/hw/board-gate.test.ts`, only with `LMS_BOARD_PORT` set), because
  Playwright cannot answer the browser's port chooser; the browser's Web Serial port is tried by
  the owner in Chrome. The port is opened raw at 115200 with `-hupcl`, so closing it does not
  drop DTR.

After the owner's review note of 15 November 2026 (`prompts/nota-agente-web.md` of the desktop
checkout).

- **The left column does not grow with its contents**: the Toolbox and the project tree scroll
  inside boxes with an edge, the Files panel takes what is left, and the board's row stays at
  the bottom in sight, also with a project of many widgets.
- **The site's icon is upstream's** (`packaging/lvgl-mpy-studio.svg`): without one the browser
  asked for `/favicon.ico` and logged a 404 at every load.
- **One error line of emscripten is dropped in the runtime's iframe**: SDL sets the swap interval
  before the main loop exists, at every window (upstream request 10).
- **The run target's menu reads "Run on: …"**: in a menu bar, a bare "Simulator" next to
  "Device" looked like a menu of its own.
- **A port not chosen is said** in the Output and the status bar, so that Start on a board
  target, cancelled in the browser's chooser, does not end in silence.
- **The board's e2e tests choose the board as run target themselves**: from upstream's next tag
  the examples run in the simulator (upstream removed their `runTarget`).
- **The upstream bundle is named after its contents too** (`lms-upstream-<tag>-<sha256>.zip`):
  the py/ glue and the wheels change between two releases of upstream, and a browser that kept
  the zip of an earlier deploy under the same name failed the worker's sha256 check. The zip's
  dates are written in local time, as a zip stores them, so the CI and a PC in another time zone
  build the same bytes.
- **The board test writes only into a folder of its own** (`lms-gate-test`) and stops before
  writing if the board already has it. Its first run on the STM32H7_CORE used `/flash/shell`,
  which held the owner's copy of the shell example: the upload replaced its files and the
  removal deleted them. The eight files of the example were written back the same day (the same
  files the IDE copies there; which version was there before is not known).
- **Before removing the folder a program ran from, the test restarts the interpreter**: on the
  STM32's FAT the current folder cannot be removed (upstream request 11).

## Phase 7 (2026-11-15)

- **`build/web.py` runs unchanged in Pyodide** (`py/lms_bridge.py` `web_build`, `program_web`):
  only `compile_python` is answered from compilations the page made first with mpy-cross in
  WebAssembly, as for the budget, so the game's `.mpy` files carry the file names, not the host's
  temporary paths (upstream request 8). The runtime is written where `web_runtime()` looks for
  it, and the bundle carries `runtime/web`, the page's template.
- **The folder opens in a new tab of the IDE's own site**: the desktop serves `dist/<name>-web` on
  127.0.0.1 and opens it; here a service worker of its own scope, `preview/`
  (`public/preview/sw.js`), serves the files the page put in the Cache Storage. One web version
  at a time, as the desktop serves one. The tab opens from a link in the dialog shown when the
  build is ready: a tab opened after the build's awaits would be blocked as a pop-up.
- **The zip holds the folder with its name** (`Snake-web/…`), as the desktop's `dist/` does, and a
  folder of the PC gets `<name>/`, replaced only when it holds the IDE's marker, as `build_web`
  refuses to replace another folder.
- **The reference file lists come from upstream's own `build_web` on the host**
  (`scripts/web-files.py`), with the native mpy-cross and the web runtime of a desktop checkout,
  which the submodule does not carry.
- **Every zip the IDE writes has its dates in local time**, as a zip stores them: the export of a
  folder had the same time-zone dependence as the upstream bundle.

## Upstream v0.7.1 (2026-11-15)

- **The submodule moves to `v0.7.1`** (`89a105f`), at upstream's note. The two runtime assets of
  the release are the `v0.7.0` zips under new names, byte for byte: `runtime.lock.json` changes
  only `tag`, `asset` and `url`, and `pnpm assets` downloaded them with the same sha256 and wrote
  no file.
- **The references made on the host were made again** at `v0.7.1`: goldens, budgets, frames,
  previews, fonts, web file lists, designer workflows and the `mpy-cross` outputs. What changed
  is upstream's: the new `sysmon` example (goldens, budget, previews, web version), `eim-01`
  without em dashes (its
  Overview and Trends previews, its budget and `.mpy`), and `gen/output/c_templates.py`. The font
  references changed only in the version they name.
- **`eim-01`, `eim-01-480` and `weather` start in the simulator**: they no longer carry a
  `runTarget`, so Start opens no port chooser for them, and the 4 designer workflows on `weather`
  save it without one. The board tests choose their run target.

## Phase 8 (2026-11-15)

- **A service worker written by hand, not a plugin.** The build lists every file of `dist/`
  with its sha256 (`scripts/sw-plugin.mjs`) and puts the list into `src/pwa/sw.js`, about 120
  lines; no new dependency. The version of the worker is the hash of that list, so a deploy that
  changes no file offers no update.
- **A cache per deploy, files reused by sha256.** "Pyodide, the runtime and the upstream bundle
  per tag" from the plan, done per file: a file whose sha256 did not change since the deploy
  cached before is copied from that cache. Pyodide (13 MB) and the runtime (6 MB) are downloaded
  again only when their pins move; the bundle's name already carries its hash. Each file downloaded
  is checked against its sha256, first from the HTTP cache and then from the server: a host still
  serving part of an older deploy fails the install, which the browser tries again later, instead
  of caching a mix.
- **Registered once Python is ready**, so the 23 MB cached for offline use do not slow the first
  start.
- **The update is offered, never forced.** A new deploy installs beside the old one and waits;
  the status bar says "A new version of the IDE is ready." with Reload. Reload asks the browser's
  own question when there are unsaved changes (`beforeunload`). An hourly check, and one when the
  tab is shown again, ask the host for a new `sw.js` (`updateViaCache: 'none'`).
- **The icons are drawn from upstream's SVG** with Qt by `scripts/icons.py`, as upstream's
  `packaging/make_icon.sh` draws its `icon.ico`; the PNGs are committed. The maskable one draws the
  icon in the middle 80 % on its own background colour.
- **Service workers are blocked in the e2e tests** apart from `pwa.spec.ts` and `web.spec.ts`:
  each test has a new browser context, which would download the whole site again.
- **The preview of a web version stays online-only.** Its worker (`public/preview/sw.js`) is
  registered from the server, and a browser fetches a worker's script past every service worker.
  The zip and Save to a Folder need no worker of their own, but were not tried offline.

## Phase 9 (2026-11-15)

- **Upstream's catalogue, read as it is.** `src/i18n/tr.ts` imports upstream's `it.json` and does
  what `core/i18n.py` `tr` does: the English of the code is the key, a text already translated is
  taken back to English, `{name}` is filled after translating. The web's own texts are in
  `src/i18n/it-web.json`, which never overrides `it.json`; a text that upstream adds is dropped
  from it (`tests/unit/translations.test.ts`).
- **`scripts/tr-strings.mjs` finds the texts with the TypeScript parser**: every `tr('…')` and
  `N_('…')` of `src/`. `N_` marks a text written before the language is known (a table's headings);
  the few `tr()` of a variable get their texts from those.
- **The language at once, without a restart**, as the desktop's `apply_language`: every Lit element
  renders again, and Python's language is set by the first call to the worker, so the Toolbox and
  Properties come translated from upstream.
- **Without a saved choice, the browser's language decides.** The desktop starts in English; a web
  page is expected to follow the browser. The tests pin the browser to `en-US`, and Node's
  `navigator.language`, which follows the PC, is set to English for the unit and Python tests.
- **The menu bar is an ARIA menubar**, with the role inside its shadow root so that its items are
  its children in the accessibility tree. F10 reaches it, as in desktop applications; the desktop's
  Alt mnemonics are left out because Alt+letter belongs to the browser.
- **axe-core in the e2e tests** (`@axe-core/playwright`, MPL-2.0, a dev dependency). It found three
  things, fixed: the menubar's children, a page without a level-one heading (now a hidden one), the
  code editor's area not reachable when read-only (the code is in the Tab order now).
- **The code editor's colours are the desktop's** `ui/theme.py` `CodeColors`, as CSS variables for
  light and dark; CodeMirror's default style had dark blue keywords on the dark background.

## Phase 10: capture hooks (2026-11-18)

Asked by an outside video recorder that drives the IDE with Playwright; the contract is
`docs/capture.md`.

- **Off unless `?capture=1`.** The IDE in normal use runs none of it: no listeners, no frames sent,
  the user's workspace and settings as before.
- **No change upstream.** The runtime reads its clocks from the page (`performance.now()` for
  lvsim, `Date.now()` for MicroPython) and its random numbers from `crypto.getRandomValues()`.
  Replacing those three in the simulator's iframe, before the runtime loads, gives a clock that
  moves only by steps and a fixed seed. On the Python side, a few lines before `import main`, as the
  first-frame mode already did: `lvsim` in `sys.modules` through a wrapper whose `present()` hands
  the frame buffer's address (`uctypes.addressof`) to the page, which copies it from the
  WebAssembly memory; `display_driver.poll()` waiting for the next step; `time.sleep*()` moving the
  clock. Generated code and upstream files stay as they are.
- **The frame buffer, not the canvas.** The simulator draws with WebGL, and reading its canvas from
  outside needs `preserveDrawingBuffer`. The RGB565 buffer is what upstream's `build/visual.py`
  compares, and the same conversion gives RGBA.
- **A pointer by steps.** The mouse reaches the runtime through SDL in real time, so a click between
  two steps may be lost or land a step later. `pointer(x, y, pressed)` sets what the project reads at
  the next step, in display pixels, whatever the zoom.
- **Stable names from the English text.** `data-capture` of a menu item is made from its English
  text, found back from the translation as `tr()` does, so the names are the same in every language
  without a list to keep.
- **Not done yet**: the demonstration board (point 6 of the request, "later"), the browser's
  tooltips, and the manual clock for programs without pages, whose loop is upstream's
  `lms_web_boot.py`.

## Upstream v0.7.2 (2026-11-18)

- **The submodule moves to `v0.7.2`** (`d4e461b`), for boards from a file. The runtime assets are
  again the earlier zips under new names, with the same sha256: `runtime.lock.json` changes only
  `tag`, `asset` and `url`.
- **Most of the release is tests** (the desktop's suites run by hand, the virtual board, the
  showreel tool). What reaches the web: `core/boards.py` with boards from a file,
  `lv.init()` always before `ui` and `app_events` in the generated `main.py`, names over 200
  characters refused, `mpremote … resume fs cp` (a copy no longer soft-resets the board), and
  `it.json`, which now has `Terminal` and `Widgets`, dropped from `it-web.json`.
- **The references were made again**: goldens, budgets (the earlier `lv.init()`), fonts and frames
  and previews (only the version they name), `mpy-cross` outputs. The designer workflows and the
  web file lists did not change.
- **Import… and Export… in the profile manager use upstream's functions**: `read_profile_file`
  checks the file (64 KiB at most, UTF-8 JSON, the catalog's diagnostics), a built-in id is refused
  with upstream's message, an id already there is replaced only after a question, and Apply keeps
  the imported ids in upstream's `board-profiles.json` under `imported`. The file comes from the PC
  with the browser's file input and goes back as a download, as `QFileDialog` reads and writes
  files of the PC; a file of the workspace can be downloaded first. A project whose board is not in
  the catalog opens with upstream's notice in Output.
- **The adapter list takes the adapter of an imported board** as an option, selected on the option:
  a value given to the `<select>` was applied before its new option existed and showed the first
  adapter (found by the new e2e test).
- **New exclusions in Pyodide**: `tests/manual` (suites the desktop runs by hand with
  `pytest --manual`, which import PySide6), `tests/test_window_checks.py` (PySide6), and four tests
  with `qtbot`. The board test that counted a soft reset per copied file now counts one, as
  upstream does since `resume`.

## Phase 10: the demonstration board (2026-11-18)

Point 6 of the capture request: the real flow of a board, with no hardware.

- **A port, not a mode of the IDE.** The board is an object with what `BoardPort` uses of a Web
  Serial `SerialPort` (`open`, `readable`, `writable`, `getInfo`, `setSignals`, `close`). The
  worker, mpremote and upstream's DeviceSession run unchanged, so what is shown is what a USB
  board gets. The port names itself "Demo board (simulated)" in the status bar and the Files panel.
- **The firmware is the simulator's MicroPython** in a sandboxed iframe (`src/board/demo-frame.js`),
  with its event-driven REPL (`replProcessChar`), which has the raw REPL. Upstream's
  `runtime/program/display_driver.py` (contract 1) and `lms_sandbox.py` make it a board with a
  display and a flash; the profile's firmware modules the browser's MicroPython has not (`gt911`,
  `rgbpanel`) are empty modules, because the IDE only checks that they import.
- **What a board does and that MicroPython does not, the page does**, as upstream's virtual board
  (`tests/virtual_board.py`) does with its process: a soft reset loads the iframe again with the
  flash; LVGL is served every 5 ms while the REPL waits, as a board's timer; raw-paste is answered
  "not supported" (`R\x00`), so mpremote sends plain raw REPL input; Ctrl-C during a command
  schedules a KeyboardInterrupt. Emscripten's error numbers are those of Linux in the VFS
  (ENOENT 2, not 44): mpremote's `cp` reads ENOENT to tell a missing file.
- **Only where JSPI is**, as the board itself: Python waits for the port with stack switching. The
  menu entry is there in every mode, not only in capture mode: it also serves a demonstration
  without a board.
- **What it reports is its own**: the free RAM is the iframe's 32 MB heap, the free flash that of
  the browser's memory file system; they are not made to look like the profile's board.

## A widget placed at the zoom of the page (2026-11-18)

Found by the capture driver of lvgl-mpy-stage: with `?capture=1&zoom=1.4` a widget from the
Toolbox landed far from the click (y 680 for 475). An event's `clientX` and `getBoundingClientRect`
are in the viewport's pixels, which a CSS `zoom` scales, while the designer's own zoom is in the
stage's layout pixels: the point was divided by the designer's zoom only. It is now divided also by
the stage's drawn width over its layout width (`cssScale` in `src/ui/designer-view.ts`), the same in
Chromium, Firefox and WebKit, and so is the pointer of Ctrl+wheel zoom. The test places a Label at
zoom 1 and 1.4 (`tests/e2e/capture.spec.ts`); Firefox gives the mouse whole pixels of the screen,
so at 1.4 it may land one page pixel away.

## Phase 11: building a project on camera (2026-11-19)

Asked by lvgl-mpy-stage, whose agent writes the steps of a video that builds a project from
nothing; the contract stays version 1, with additions only (`docs/capture.md`, Versions).

- **Names put on at render, not written in each dialog.** The dialogs drawn by their callers
  (Project Settings, the managers, the resize question) are many and change. In capture mode the
  dialog element names each field and button after every render, from the form's own name or the
  English of its label, as the menus are named; Lit reuses elements between dialogs, so the names
  it put on are put on again each time. A label written as `tr('New Folder') + ':'` is found
  without its colon, so the names are the same in Italian.
- **Reads without Python.** `project()`, `widgetBox()` and `editor()` answer at once from what the
  IDE already holds: the session's state, the designer's pages (the same geometry the canvas
  draws, `sceneRects`), the editor's CodeMirror state. Python gives two more facts with the state it
  already sends: each page's `initial`, each widget's events.
- **Completion the same in every take, not synchronous.** The options come from Python, so the list
  cannot open within the keystroke. In capture mode CodeMirror's delays are 0 (start, update,
  the guard against an Enter right after opening) and `idle()` waits while the list waits for its
  options; after `idle()` it is open or not by the text alone. `idle()` waits for a syntax check
  that runs, not for the one an editor will start 0.5 s after the last key: a driver that waits
  after every key would otherwise wait half a second per key.
- **`settle()` beside `idle()`.** `idle()` waits for the budget's measure, due 1.5 s after the last
  change, and the contract says so; with it after every key a typed function took 1.6 s a key,
  eight minutes a take. `settle()` waits for what runs now, not for what is only scheduled, and
  `idle()` keeps its meaning.
- **`editor=plain`** takes out indentOnInput, closeBrackets and the completion, and binds Enter to
  a plain new line and Tab to a tab character, so the text is the keys typed.
- **The Events tab stays as on the desktop**: no field to type a handler in; the double click makes
  `<widget>_<event>` and opens it, which is how a person gives a widget a handler.
- **`python-error` from the Errors panel's own mapping** (upstream's `traceback_errors` through the
  source map): the file and line are those of the text a person corrects.
- **New for a Board** said the resolution twice ("ESP32-4848S040 (480×480) (480×480)"): the
  built-in profiles' names have it already, so it is added only to a name without it.

## The rename to Copper and Code Studio (upstream v0.8.0, 2026-11-20)

- **The name people see changes, the identifiers that keep data do not.** The title, the manifest
  (`Copper and Code Studio Web`, short name `Copper&Code`), the About box, the status bar, the
  window title and the texts with the product's name. The `lms` prefix stays everywhere: the
  storage keys `lms.*`, the cache names, the IndexedDB and OPFS names, `py/lms_*.py`, the release
  assets `lms-*-v*.zip`. The origin is the same, so the settings and the workspace survive.
- **The base path is written once**, in `scripts/site.mjs`; Vite's `base`, Playwright and the e2e
  tests import it, the site's code reads `import.meta.env.BASE_URL`. `OLD_BASE` is there only for
  the test that data written under the old address is read under the new one.
- **The capture contract stays version 1.** Only the About item's name moves, because menu items
  are named after their English label; Stage does not use it.
- **A web build folder with the old marker is still ours**, as upstream's `build/web.py` now
  accepts `OLD_MARKERS`: Save to a Folder writes `.copper-and-code-studio-web` and replaces a folder
  with either marker.
- **The runtime assets of `v0.8.0` are the bytes of `v0.7.2`**: the name in the runtime is in
  Python files of the bundle (`lms_web_boot.py`, `os.py`, `display_driver.py`), not in the
  WebAssembly.
- **Paths in the open upstream requests** use the new package, `copper_and_code_studio/`, so they
  can be found at the new tag; the decision records above keep the names of their time.

## A call always answered, two tabs, the tests' server (2026-11-22)

- **Every call to the Python worker gets a reply.** `lms_bridge.call` turns Python's exceptions
  into replies, but what gets past it, a `SystemExit` or a failure of Pyodide itself, was thrown in
  the worker and the page waited for ever; `handleRequest` (`src/py/host.ts`) now answers that too,
  as a `WorkerError`. A worker whose script does not load sends no message at all: the bridge
  listens to its `error` event, and before Python is ready it becomes "Python failed to start" and
  fails the calls waiting and the later ones. Once ready, an error outside a call does not stop
  the worker, so it fails nothing.
- **Reload works in a tab that another tab updated.** Reload in one tab makes the new worker take
  the other tabs over too, without reloading them (they may have unsaved changes). Their Reload
  waited for a change of worker that had already happened and did nothing; it now reloads at once
  when the worker it offered is no longer waiting (`src/pwa/pwa.ts`). Until then such a tab runs
  the old page on the new deploy's cache: a file of the old deploy that the new one dropped comes
  from the network, where it may be gone.
- **The e2e tests refuse a server that is not this folder's build.** Outside CI Playwright keeps a
  server found on the port and builds nothing, so a preview left open, also by another copy of the
  repository, had the tests judge other code. `tests/e2e/global-setup.ts` compares the `sw.js`
  served, which lists every file of a build with its sha256, with `dist/sw.js`, and fails if a
  source changed after the build; the message says to stop that server.

## Files and saves, after a review (2026-11-22)

Five defects found by a review of the code, each with a test that failed before its fix.

- **Each file tab keeps its own editor.** The panels of the file tabs are rendered keyed by the
  tab (`repeat` in `src/ui/app-shell.ts`). By position, closing a tab that was not the last handed
  its editor to the next tab with the text of the closed file still in it, and the next key typed
  there, then Save, wrote that text into the other file.
- **A rename that only changes the case of a name goes through a name of its own**
  (`renameStoreEntry` in `src/storage/store.ts`). A store has no rename: the files are copied, then
  the old ones removed. On Windows and macOS the new name is the old folder itself, so the copy
  wrote each file onto itself and the removal took everything. Checked on a store that ignores
  case as those file systems do (`tests/unit/case-blind-store.ts`), not on such a PC.
- **A name is taken in any letter case** (`nameTaken`): a rename is refused when another entry of
  the folder has the name in another case, where the old check let a folder merge into that
  entry.
- **A folder of the PC is known by itself, not by its name.** `pickFolder` asks the browser whether
  the folder chosen is one already there (`isSameEntry`); another folder with the same name is a
  new place, "PC: src (2)". By name, it took the id of the first, and the tabs, the recent files
  and the open project of the first then wrote into the second.
- **What is typed while a file is being written stays a change.** A file tab records as saved the
  text it wrote, not the text it has when the store answers (a board takes seconds). The project
  does the same: after the store has written, the session takes the state as Python has it then
  (`doc_state`), not the one `doc_save` returned before, which took the "modified" away from a
  change made meanwhile, and New or Open then dropped it without a question.

## The board's queue, the editors and the sound, after the same review (2026-11-22)

- **Nothing queued by the Files panel starts right after a program was typed at the prompt**
  (`DeviceController.finished`). Run on the Board uploads, then types the line that runs the
  program; the upload had made the Files panel ask for the folder again, and that operation,
  started at once, entered the raw REPL with a Ctrl-C and stopped the program. Upstream's
  `_device_finished` runs nothing after what followed; here what is queued still runs after a
  connection, where the panel asks while the board is busy, and waits only after a typed line.
- **A connection that fails leaves no port.** Upstream's session drops its port; the IDE kept its
  own, said "Connected" and failed every operation until Disconnect.
- **A board file operation without a board fails at once**, as `_board_task` does. Kept in the
  queue, a save made after a disconnection never ended, and was written on the board connected
  next.
- **`run_line` is upstream's function again**, to the letter (a test compares them): a path with a
  space or a parenthesis is a file to run, as upstream decided in v0.8.0, not a line of Python.
- **Cancel reaches the operation that waits.** A call that asks nothing of the board can be
  answered while an operation waits for it (the tracebacks, from a timer); it took the
  operation's cancel away with its own, and Cancel did nothing. `lms_board.call` puts it back.
- **Every call that generates waits for the fonts**: `upload`, `live_send`, `web_prepare` and
  `web_build` were missing from `GENERATING`, so an upload or a web build made right after a text
  changed could go out with Montserrat in place of the project's font. Not tested.
- **A failure does not stop the chain it was in.** The designer's refreshes and the Code tab's
  edits run one after the other on a promise; one rejection left it rejected, and no later
  refresh or edit ran. A refresh that failed is now simply over; an edit that did not reach the
  project is said in Output, and the edits after it go.
- **The Code tab reads the code again if something was typed while Python answered**
  (`CodeController.refresh`): the answer did not have that text, and taking it put the older text
  back into the editor.
- **The sound is prepared by the key or the click that starts** (`RunController`): nothing called
  `TonePlayer.prepare`, so every tone of a game was counted and none was played.
- **Left as it is: Ctrl+C on a page tab is the designer's wherever the focus is**, so text selected
  in Output cannot be copied with the keyboard. Telling a copy of text from a copy of widgets
  needs to know which the user meant: not decided. Decided on 2026-11-28: see "The second review" below.

## Upstream v0.9.0 (2026-11-24)

- **The runtime assets of `v0.9.0` are the bytes of `v0.8.0`** under the new names: the lock keeps
  the same sha256, and `scripts/fetch-runtime.mjs` checked them on the release's files.
- **What upstream changed in its interface is followed here.** After an upload the IDE says how
  many files the board had already and copied by itself (`DeviceController.startUpload`, from
  `ui/main_device.py`); the speed of the upload's window is measured only on the bytes that
  travelled, and after 8 kB of them (`UploadEstimate`, from `UploadProgress`). The upload itself
  is upstream's `DeviceSession`, unchanged: the board checks size and sha256 of each file.
- **The budget generates as `measure_budget` does**, with the fonts and the images in files of
  their own (`asset_files`): `budget_prepare` must write the same sources, or the page would
  compile files that the measure does not look for.
- **Twelve examples more, 21 in all.** Their pages are the native runtime's to the pixel in the
  designer, and ten start in the simulator. FTP Server and Photo Frame do not: they import
  `socket` when they start, and the WebAssembly runtime has none (upstream request 15). The budget
  test expects their flash and no RAM, by name, so it fails the day they start.
- **Four tests of `cac_settings` stay out of the Pyodide run** (upstream request 14): the file's
  place depends on `sys.platform`, which is `emscripten` there. A run of upstream's whole suite
  without the exclusions (`tests/py/upstream-tests.mjs --survey`) showed that every excluded test
  still fails or cannot load, and that nothing else fails.
- **Chromium's swap files are not listed** (`HandleStore.list`): while it writes `name`, Chromium
  keeps `name.crswap` beside it, in a folder of the PC and in the private file system, and a
  listing made at that moment showed it in the Files panel, where it stayed.
- **The workflow test waits for the object before it types.** The text of an object chosen in the
  Code tab reaches the editor after Python has answered; a select-all made before that lost its
  selection, and the text typed went in front of the old one (seen once, in Firefox).

## Upstream v0.9.1 (2026-11-28)

- **Nothing of the IDE's code changes.** The tag adds five board profiles and two adapters
  (`stm32h7_usb`, `stm32f769i_disco`), files of the website and the showreels. The new boards are
  reached through mpremote, as the ESP32 and the RP2350: only `stm32h7_uart` has lines of its own
  when the port opens (`BoardPort.open`). The profiles come to the menus from upstream's
  `builtin_profiles`, and the bundle packs every file of `boards/`.
- **The runtime assets are the bytes of `v0.8.0` again**, and the generated code is the same: the
  fixtures made again differ only in the version they name.
- **The boards are checked here too** (`tests/py/boards.test.ts`): the IDE lists every board of
  upstream, and each is valid and generates in Pyodide. Upstream's own test of it is in a file
  that imports PySide6 (upstream request 4), and the examples name only three of the eight boards,
  so the goldens did not reach the others.
- **The e2e tests count upstream's board files** instead of expecting three rows in the profile
  manager: the number changes with upstream's tags.
- **`test_photo_web.py` is excluded test by test.** The file was left out whole at `v0.9.0`; the
  run without exclusions showed that one of its five tests, of the file names, passes in Pyodide.
  The four that start the server stay out.

## The second review (2026-11-28)

A second review of `src`, `py` and `scripts`, with the documents and the published site. Each fix
has a test that failed before it, unless said.

Work that could be lost:

- **Open, save and reload take turns** (`ProjectSession.oneAtATime`). Each copies the project's
  file between its store and Python in several steps; a second save starting among the steps of
  the first (Ctrl+S held down, F5 twice) put the old file back, and upstream took it for a change
  made outside, or the first save wrote it to the store as the project just saved.
- **A file tab is opened once and closed once** (`FileTabs.opening`, `closing`). A tab closed again
  while its save was being written removed the last tab of the list, with its text; a file of the
  board opened twice during its slow read had two tabs.
- **Add Page takes the first free name**, as upstream since `v0.8.0`: after a page was deleted,
  the count named one that was still there.
- **A program runs from where its files were saved** (`FileTabs.saveProgram`). A changed example
  is saved into its copy in the workspace, and Run Program, Run on the Board and Run in the
  Browser then went on with the example, without the change.
- **A file deleted from a program's folder leaves the next run** (`copyProgramIntoPython`).
- **The demonstration board keeps its flash** when it is closed before it has started: the frame
  answers that it has nothing to hand over, not an empty flash.

The keys:

- **The copy keys are the designer's only where they are the designer's.** Ctrl+C, X, V, D and A
  act on the canvas when the Edit menu's item would be enabled (Cut, Copy and Duplicate need a
  selection: without one they emptied what was copied), and not in Output or Errors, whose text
  they select and copy, as a text widget of the desktop keeps these keys for itself. The two
  panels are marked `data-own-text`, and Ctrl+A there selects the panel, not the page. This is the
  point the review of 2026-11-22 left open.
- **Nothing of the window answers behind a modal dialog** (a question, the upload's progress,
  About), as a modal `QDialog` blocks the window's shortcuts. F5, Ctrl+S and Ctrl+O stay taken
  from the browser, which would load the page again or save it as a file.

The board:

- **Live Editing asks before it takes the board** (`live_check`, then `live_send`). The check was
  a device task: at every change and every tab shown it raised the Device Console, locked the IDE
  and took the port from the running app, to send nothing. Upstream compares the keys first.
- **Run on the Board without a board profile says so**: `program_root` answered with an error
  that nobody showed.
- **A port opened is closed again** when the connection fails after `port.open`, or after a write
  that failed: left open, every new attempt found it "already open" until the page was loaded
  again. Tried with a port that fails where a real one can, not with a real adapter.
- **The tabs of the files under a renamed folder of the board follow it**, as in the workspace
  (`FileTabs.renamed`).
- **A board is "usable" through Web Serial or as the demonstration board** (`DeviceController.usable`):
  with JSPI and no Web Serial the demo board connected, and Start, its files and Run on the Board
  did not follow. No test: no engine of the tests is so.
- **An operation that waited its turn keeps its failure handler**, and an upload that waited
  closes its progress window when the board goes.

What does not load:

- **mpy-cross is tried again after a load that failed**, and the workers of mpy-cross and of the
  fonts answer for themselves when they do not load. Before, Start stopped without a word until
  the page was loaded again, and every call that generates code waited for a font for ever.

The site:

- **The site serves its licences** (`scripts/licenses.mjs`, `public/licenses/`): the IDE's own, and
  the notices of the packages its JavaScript is made of, which the build's minifier removes and
  MIT and BSD ask to keep with every copy. The About box links them, the source and the
  documentation, with the desktop's sentences about the licence and the warranty; Help has Online
  Documentation, as the desktop. The desktop's Credits and Copyright lines are there too, by the
  owner's choice.
- **The page names itself** to search engines and to the preview of a shared link (description,
  Open Graph), has a line for a browser without scripts, and a page for an address that is not
  there.
- **xterm.js loads when the first terminal opens** (`src/ui/terminal.ts`): it was a third of the
  IDE's first script. What is written before is kept and written when the terminal opens.

The designer's preview:

- **A frame with MicroPython already started waits for the next drawing** (`Simulator`'s `warm`
  option). Each drawing made a new iframe, sent it 5.9 MB and waited for the runtime to be
  compiled and started: 260 to 340 ms of the 450 to 530 ms of a drawing. Now a spare frame is made
  ready after each drawing, and the next only sends the files: 280 to 340 ms measured in Chromium
  and Firefox on one PC. While a widget is dragged the drawings follow one another and gain
  nothing: the work is the same.
- **A widget dragged back to where it was is drawn where it is**: the page was left as the drag
  last drew it.

The tools:

- **The lint checks the promises with the types** (`no-floating-promises`, `no-misused-promises`,
  `await-thenable`): three places to change. The other typed rules are about style.
- **The CI runs the browsers in three jobs**, one for each engine, and not at all for a commit of
  documents only. Not run yet when this was written.
- **`pack-runtime.mjs` packs with a local time**, one o'clock: the same bytes as the assets
  published so far, packed in Italy, and the same in every time zone.

Left open:

- **The web version opened from the IDE runs in the IDE's origin.** Run → Open in Browser serves
  the folder under `preview/`, in a tab of the site, and the runtime has MicroPython's `js` module:
  the code of a project reaches there what the IDE keeps in the browser (the workspace, the
  settings, the folders of the PC it was given, the cached site). The simulator is in a sandboxed
  iframe; this is not. Serving the page with `Content-Security-Policy: sandbox` does not work: a
  page with an opaque origin is not served by a service worker (tried in the three engines). A
  sandboxed iframe fed by the page works only if the folder's modules are rewritten, since a module
  loaded from a `blob:` URL cannot resolve `./micropython.mjs`. The owner's to decide.
