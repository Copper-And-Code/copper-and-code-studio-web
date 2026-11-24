# Requests to upstream

Changes this project needs in the desktop repository. The owner decides each one. The change is
made upstream, on a branch there, and this repository moves the submodule only once it is
tagged.

| #   | Request                                                 | State                         |
| --- | ------------------------------------------------------- | ----------------------------- |
| 1   | Web runtime as a release asset                          | done for `v0.7.0` to `v0.9.0` |
| 2   | `mpy-cross` in WebAssembly as a release asset           | done for `v0.7.0` to `v0.9.0` |
| 3   | A CI check that the Qt-free packages stay Qt-free       | proposed                      |
| 4   | Test files that load without Qt                         | proposed                      |
| 5   | The project document without Qt                         | proposed                      |
| 6   | The browser loaders with a host interface               | proposed                      |
| 7   | The preview after a quick undo                          | proposed                      |
| 8   | `.mpy` files without the temporary folder's path        | proposed                      |
| 9   | The board's file helpers without Qt                     | proposed                      |
| 10  | No swap interval before the main loop                   | proposed                      |
| 11  | Removing the folder a program ran from                  | proposed                      |
| 12  | The web IDE's texts in `it.json`                        | proposed                      |
| 13  | An LVGL assertion that does not spin in the web runtime | proposed                      |
| 14  | The tests of `cac_settings` on any platform             | proposed                      |
| 15  | Examples that start without `socket`                    | proposed                      |

---

## 1. Web runtime as a release asset

**What.** Attach to every GitHub release a zip `lms-web-runtime-<tag>.zip` containing
`micropython.mjs` and `micropython.wasm`, the output of `runtime/build_web.sh`, and the licence
texts of `gen/output/licenses/` in `licenses/`.

**Why.** The web IDE needs the same runtime that upstream's browser demos use, at the same tag.
It must not build Emscripten (about 1 GB of SDK), and it must not commit 6 MB of binaries.
The submodule alone does not carry the runtime: upstream's `.gitignore` leaves out
`runtime/out-web/`.
`scripts/pack-runtime.mjs <folder>` makes the zip, byte for byte the same on every run, and
writes `runtime.lock.json` with its sha256. `scripts/fetch-runtime.mjs` downloads the asset of
the pinned tag, checks it against the lock, and unpacks it into `public/runtime/`. For each new tag the asset
must be uploaded before the submodule moves, or the web CI fails at `pnpm assets`.

**State on 14 November 2026.** The owner chose this path. The zip for `v0.7.0` was made from the
runtime of the owner's desktop checkout (`runtime/out-web/`, built on 10 November; the runtime's
C sources did not change between `v0.6.1` and `v0.7.0`): 2 258 499 bytes, sha256
`a8c824d4bcd65a987888debc7914a1c1eff26473c1bcdafba8d3b2469b72a00d`. Uploaded to the release `v0.7.0` on 14 November 2026; the downloaded asset has the same sha256.

**Where.** The release step (by hand or a workflow), after `runtime/build_web.sh`.

**Test.** Here: `pnpm assets` in CI downloads it and checks the sha256; the simulator's e2e tests
then run on 3 engines.

## 2. `mpy-cross` in WebAssembly as a release asset

**What.** Build `mpy-cross` with Emscripten, from the same pinned MicroPython as the runtime, as
a module that takes a source file and returns the `.mpy` bytes or the error text. Publish it
next to the runtime, in the same zip or as `lms-mpy-cross-<tag>.zip`.

**Why.** The editor's syntax check, and uploading `.mpy` files, which the RP2350 needs, both use
`mpy-cross`. In the browser there is no process to start.

**Where.** A `runtime/build_mpy_cross_web.sh` next to `build_web.sh`.

**Test.** Compile every `.py` of `examples/` with the native and the wasm `mpy-cross`: the
`.mpy` files are byte-identical, and a file with a syntax error gives the same message, file
and line.

**State on 14 November 2026.** Built here by `scripts/build-mpy-cross-web.sh`, at the owner's
choice, and uploaded by the owner to the release `v0.7.0` as `lms-mpy-cross-v0.7.0.zip` (sha256
`dc72a1e1ec7c1f60e9b06657f66792620106a31bdbb3268910c3c459ff39073e`, in `runtime.lock.json`).
The downloaded asset has the same sha256.

## 3. A CI check that the Qt-free packages stay Qt-free

**What.** Extend `tests/test_modules.py::test_core_modules_do_not_import_qt`. Today it imports
three modules (`core.modules`, `core.model`, `core.validation`) in a fresh interpreter and checks
that PySide6 is not loaded. It would import every module of `copper_and_code_studio/core`, `gen`,
`build`, `sim` and `blocks`, and also fail on `serial` and `mpremote`.

**Why.** The web IDE runs these packages in Pyodide, where none of those exist. Today it works:
`tests/py/audit.test.ts` here imports all of them in Pyodide. Upstream does not see a regression
until this repository moves to the next tag; a test upstream would catch it when it is written.

**Where.** `tests/test_modules.py`, the test above, with `pkgutil.walk_packages` over the five
packages.

**Test.** The test itself. Adding `import PySide6` at the top of a module of `gen/` makes it
fail.

## 4. Test files that load without Qt

**What.** 25 test files import PySide6, or the `ui/` package, when they are loaded, also those
that hold tests of the core. Without Qt the whole file fails to load, its Qt-free tests
included. A rough count gives about 70 of their 322 tests that use no Qt object: for example in
`test_validation.py`, `test_project_id.py`, `test_budget.py`, `test_device_files.py`,
`test_images.py`. The request: import Qt inside the tests that need it, or with
`pytest.importorskip("PySide6")` in a file of Qt tests only, or move the Qt-free tests to their
own files.

**Why.** Those tests check the code the web IDE runs. Today they are excluded from the Pyodide
run as whole files (`tests/py/exclusions.json`), so a regression there is not seen here.

**Where.** The 25 files listed under `files` in this repository's `tests/py/exclusions.json`.

**Test.** `pytest --continue-on-collection-errors` in an environment without PySide6 loads every
test file with no collection error; the Qt tests are skipped.

## 5. The project document without Qt

**What.** Move the Qt-free logic of `ui/document.py` (`ProjectDocument`: open, save, Save As
with a new `projectId`, the outside-change check, reload; `SnapshotCommand`; `ExternalChangeError`)
and `ui/main_files.py` `_default_project` into a module without Qt, for example
`core/document.py`, with a small undo stack of its own. `ui/document.py` keeps the Qt signals and
the `QUndoStack` on top of it.

**Why.** The web IDE needs exactly this logic, and it cannot import Qt. Today it runs a
temporary copy, `py/lms_document.py`, which follows upstream line by line; any fix upstream has
to be copied by hand until this moves. Phase 5 (the designer) will lean on the undo stack even
more.

**Where.** `copper_and_code_studio/ui/document.py`, `copper_and_code_studio/ui/main_files.py`, a new
`copper_and_code_studio/core/document.py`.

**Test.** The tests of `ui/document.py` that need no window, moved to a test of the new module;
it runs without PySide6. Here, `tests/py/session.test.ts` keeps passing with the copy deleted.

## 6. The browser loaders with a host interface

**What.** Let `runtime/web/lms_program.js` and `lms_web.js` take what they now fetch and print
from a small host object when the page provides one: the files to run, the system files, where the
output goes, the keys. Without a host they behave as today.

**Why.** The web IDE runs the simulator in a sandboxed iframe with an opaque origin, so that a
program cannot reach the IDE's files and Stop can drop it whole. Such a frame cannot load module
scripts from the IDE's origin without CORS headers, and the IDE sends the runtime, the files and
the keys by `postMessage`, not by URL. So `src/sim/frame.js` repeats what the two loaders do
(writing the files, `lms_board.py`, running `lms_web_boot` or `main.main()`, the keys of the
terminal) with `postMessage` in their place. With a host interface upstream, the IDE would load
upstream's loaders as they are, and a change to them would reach the IDE with the next tag.

A detail seen while reading `lms_web.js` (not reproduced): after `main.main()` returns it calls
`proxy_convert_mp_to_js_obj_jsside_with_free`, which `micropython.mjs` defines inside its own
module; from `lms_web.js` the name is not defined, so the end of a game would raise a
`ReferenceError` in the console instead of the game's error, if it had one.

**Where.** `runtime/web/lms_program.js`, `runtime/web/lms_web.js`.

**Test.** Upstream's browser test of the shell demo, unchanged; here, `tests/e2e/simulator.spec.ts`
with `src/sim/frame.js` reduced to the host object.

## 7. The preview after a quick undo

**What.** In `ui/designer/preview.py`, `PreviewRenderer.request` returns early when the page was
last drawn with the same `design_key`. Skip that early return while a rendering is running or
its timer is pending; `_start` then draws the latest request, as it already does with `_dirty`.

**Why.** A change starts a rendering of the new page; an undo right after it asks for the page
as it was, whose key is still the one in `_done`. The request is dropped, the rendering of the
change ends, and the canvas keeps showing the change that was undone until the next edit. The web
IDE reimplements the renderer (`src/app/preview.ts`) and met it in its tests: a drag released and
Ctrl+Z at once. On the desktop it has not been reproduced; the logic is the same, so the window
for it is the time a rendering takes.

**Where.** `copper_and_code_studio/ui/designer/preview.py`, `PreviewRenderer.request`.

**Test.** With a fake `render` that waits for an event: request key A, then B, then A again while
B is rendering; after it, the renderer draws A once more.

## 8. `.mpy` files without the temporary folder's path

**What.** In `build/compiler.py`, `compile_python` runs mpy-cross on `str(path)`, the absolute
path, from the folder of the files. Give it `path.name` instead (the folder is already `cwd`), as
`gen/board_gen.py` does with `-s`.

**Why.** mpy-cross stores the source name in the `.mpy`. With the absolute path, each file carries
the temporary folder's path: on Linux 113 bytes more for a one-line file. The budget's flash of a
project without a compatible board grows by that, and depends on where the system keeps
temporary folders; fifteen measures 13331 bytes on Linux and 13095 with the names. The web IDE
compiles with the names, so its number is the second one (`scripts/budgets.py`). Tracebacks of the
simulator would also show `ui.py` instead of a temporary path.

**Where.** `copper_and_code_studio/build/compiler.py`, `compile_python`.

**Test.** `measure_budget` of an example without a board gives the same flash from two different
temporary folders.

## 9. The board's file helpers without Qt

**What.** Move `folder_items`, `run_line`, `protected_targets`, `shadowed_modules`, `DESTINATIONS`
and `SKIPPED` from `ui/device_files.py` into a module without Qt, for example
`device/files.py`; `ui/device_files.py` imports them from there.

**Why.** They are pure functions about the board's files, but their module imports PySide6 for
`UploadFilesDialog`, so the web IDE cannot import them. It keeps a copy in `py/lms_board.py`,
which can drift from upstream.

**Where.** `copper_and_code_studio/ui/device_files.py`, `copper_and_code_studio/ui/main_device.py`,
`copper_and_code_studio/ui/main_editors.py`.

**Test.** The existing tests of the four functions, importing them from the new module without
PySide6 installed.

## 10. No swap interval before the main loop

**What.** In the web runtime, do not set the swap interval (SDL's `SDL_GL_SetSwapInterval`,
which reaches emscripten's `_eglSwapInterval`) before `emscripten_set_main_loop`, or set it after
the main loop exists.

**Why.** Each time the runtime creates its window, emscripten logs
`emscripten_set_main_loop_timing: Cannot set timing mode for main loop since a main loop does
not exist!` as an error. It is harmless, but it shows in the browser console for every simulator
and every preview of the designer, where it looks like a fault. The web IDE drops that one line
in its iframe (`src/sim/frame.js`).

**Where.** `runtime/web/` (the SDL set-up of the web build), `runtime/build_web.sh`.

**Test.** Start the web runtime in a page and check that the console has no error at start.

## 11. Removing the folder a program ran from

**What.** In `device/service.py` `remove_path`, before removing, change the board's current
folder to `/` when it is the path being removed or inside it (`os.getcwd()`).

**Why.** Run File on Board and Run on the Board start a program with `os.chdir` into its folder
(`ui/device_files.py` `run_line`), and the folder stays the current one after Stop. On the FAT of
the STM32H7_CORE's `/flash`, `os.rmdir` of the current folder fails with `EACCES` after all its
files are removed: Delete… on that folder then leaves it empty and reports an error. Seen on
2026-11-15 by the web IDE's board test; the desktop runs the same script.

**Where.** `copper_and_code_studio/device/service.py`, `DeviceSession.remove_path`.

**Test.** With a fake board whose `os.rmdir` refuses the current folder: run a file of a folder,
stop, remove the folder; it is gone.

## 12. The web IDE's texts in `it.json`

**What.** Add to `copper_and_code_studio/translations/it.json` the 88 texts of
`src/i18n/it-web.json` of this repository, with their Italian as written there.

**Why.** The web IDE translates with upstream's own catalogue, by the same English keys
(`src/i18n/tr.ts` follows `core/i18n.py` `tr`). The texts that exist only on the web (the
workspace, import and export, Web Serial, the web version's dialog, the offline update) and a
few that the desktop shows too but `it.json` does not have (`Toolbox`, `Output`, `Yes`, `No`, `OK`)
are kept in `src/i18n/it-web.json` until upstream has them. Once a text is in `it.json`, the web
IDE drops it from its own file (`tests/unit/translations.test.ts` refuses a text in both).

**Where.** `copper_and_code_studio/translations/it.json`.

**Test.** Upstream has no test of the catalogue's keys against its code (checked at `v0.7.1`), so
extra keys break nothing; the web IDE's `tests/unit/translations.test.ts` checks the rest.

## 13. An LVGL assertion that does not spin in the web runtime

**What.** In the web build of the runtime, make `LV_ASSERT_HANDLER` end the program with an error
that reaches MicroPython or the page (for example `abort()`, or a call the web build provides),
instead of the default `while(1);`.

**Why.** `runtime/lv_conf.h` halts on an assertion, as a board must. In the browser the runtime runs
in the page's own thread, so the halt blocks the whole tab: the IDE stops answering, and only
closing it helps. It is easy to reach: `x = lv.obj()` at the top of the general code runs at
`import app_events`, before `display_driver.init()` makes a display, and LVGL asserts on the
missing display. The RAM budget measures the project 1.5 s after a change, so typing that line is
enough. On the desktop only the simulator's process hangs. Found on 2026-11-19 by the web IDE's
phase 11 tests.

**Where.** `runtime/lv_conf.h` (`LV_ASSERT_HANDLER`), `runtime/build_web.sh`.

**Test.** In the web runtime, `import lvgl as lv; lv.obj()` before the display exists ends with an
error, and the page goes on answering.

## 14. The tests of `cac_settings` on any platform

**What.** Make the fixture of `tests/test_cac_settings.py` say where the settings file is, instead
of relying on the platform: for example `monkeypatch.setattr(module, "path", lambda: "cac_settings.json")`
after loading the module, or `monkeypatch.setattr(sys, "platform", "linux")`.

**Why.** `cac_settings.path()` keeps `cac_settings.json` next to the program only where
`sys.platform` is `linux`, `darwin` or `win32`; elsewhere it is `/flash/cac_settings.json` or
`/cac_settings.json`, as on a board. The fixture moves into `tmp_path` and expects the file there.
In Pyodide `sys.platform` is `emscripten`, so the file goes to `/cac_settings.json`: four tests
look for it in `tmp_path` and fail, and one test finds the file another left
(`test_the_file_is_written_whole`, `test_a_broken_file_reads_as_empty`,
`test_connect_without_saved_networks_or_when_already_connected`,
`test_a_section_is_kept_apart_from_the_networks`). The web IDE leaves the four out of its run
(`tests/py/exclusions.json`). Checked at `v0.9.0`.

**Where.** `tests/test_cac_settings.py` (the `settings` fixture).

**Test.** The file's own tests, on a platform that is none of the three: in Pyodide, or with
`sys.platform` patched to another name.

## 15. Examples that start without `socket`

**What.** In FTP Server and Photo Frame, import `socket` where the server starts, not when the
module loads, and go on without the server where there is no `socket`, as the same examples
already do for `network` (the made-up clients of FTP Server, the demo photos of Photo Frame).

**Why.** `ftp_server` (FTP Server, line 18) and `photo_web` (Photo Frame, line 22) import `socket`
at the top, and the general code imports them when the app starts. The WebAssembly runtime
(MicroPython's `webassembly` port) has no `socket`: both examples stop there with
`ImportError: no module named 'socket'` in the web IDE's simulator. The web version that
`build/web.py` makes runs the same code in the same runtime (not tried). The other ten examples that came with `v0.9.0` start
in the browser. In the web IDE the RAM of these two cannot be measured either, because the budget
runs the app. Seen in Chromium on 2026-11-24.

**Where.** `examples/ftp-server/project.json` (module `ftp_server`),
`examples/photo-frame/project.json` (module `photo_web`).

**Test.** Each example started in the web runtime reaches its first screen; upstream's
`tests/test_example_files.py` could import each module of an example with `socket` missing.
