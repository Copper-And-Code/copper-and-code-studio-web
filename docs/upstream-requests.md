# Requests to upstream

Changes this project needs in the desktop repository. The owner decides each one. The change is
made upstream, on a branch there, and this repository moves the submodule only once it is
tagged.

| #   | Request                                           | State                                         |
| --- | ------------------------------------------------- | --------------------------------------------- |
| 1   | Web runtime as a release asset                    | done for `v0.7.0` (asset uploaded 2026-11-14) |
| 2   | `mpy-cross` in WebAssembly as a release asset     | proposed                                      |
| 3   | A CI check that the Qt-free packages stay Qt-free | proposed                                      |
| 4   | Test files that load without Qt                   | proposed                                      |
| 5   | The project document without Qt                   | proposed                                      |
| 6   | The browser loaders with a host interface         | proposed                                      |

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

## 3. A CI check that the Qt-free packages stay Qt-free

**What.** Extend `tests/test_modules.py::test_core_modules_do_not_import_qt`. Today it imports
three modules (`core.modules`, `core.model`, `core.validation`) in a fresh interpreter and checks
that PySide6 is not loaded. It would import every module of `lvgl_mpy_studio/core`, `gen`,
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

**Where.** `lvgl_mpy_studio/ui/document.py`, `lvgl_mpy_studio/ui/main_files.py`, a new
`lvgl_mpy_studio/core/document.py`.

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
