# Requests to upstream

Changes this project needs in the desktop repository. The owner decides each one. The change is
made upstream, on a branch there, and this repository moves the submodule only once it is
tagged.

| #   | Request                                           | State    |
| --- | ------------------------------------------------- | -------- |
| 1   | Web runtime as a release asset                    | proposed |
| 2   | `mpy-cross` in WebAssembly as a release asset     | proposed |
| 3   | A CI check that the Qt-free packages stay Qt-free | proposed |
| 4   | Test files that load without Qt                   | proposed |

---

## 1. Web runtime as a release asset

**What.** Attach to every GitHub release a zip `lms-web-runtime-<tag>.zip` containing
`micropython.mjs` and `micropython.wasm`, the output of `runtime/build_web.sh`, plus
`SHA256SUMS`.

**Why.** The web IDE needs the same runtime that upstream's browser demos use, at the same tag.
It must not build Emscripten (about 1 GB of SDK), and it must not commit 6 MB of binaries.
The submodule alone does not carry the runtime: upstream's `.gitignore` leaves out
`runtime/out-web/`.
Until the asset exists, `scripts/fetch-runtime.mjs` takes the files from a local
`upstream/runtime/out-web/` and records their sha256, and the web CI cannot run the simulator
tests.

**Where.** The release step (by hand or a workflow), after `runtime/build_web.sh`.

**Test.** For the release, download the asset, check `SHA256SUMS`, and load the shell demo page
from it in headless Chromium, as the existing browser test does.

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
