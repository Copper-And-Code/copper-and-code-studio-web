# Requests to upstream

Changes this project needs in the desktop repository. The owner decides each one. The change is
made upstream, on a branch there, and this repository moves the submodule only once it is
tagged.

| #   | Request                                           | State    |
| --- | ------------------------------------------------- | -------- |
| 1   | Web runtime as a release asset                    | proposed |
| 2   | `mpy-cross` in WebAssembly as a release asset     | proposed |
| 3   | A CI check that the Qt-free packages stay Qt-free | proposed |

---

## 1. Web runtime as a release asset

**What.** Attach to every GitHub release a zip `lms-web-runtime-<tag>.zip` containing
`micropython.mjs` and `micropython.wasm`, the output of `runtime/build_web.sh`, plus
`SHA256SUMS`.

**Why.** The web IDE needs the same runtime that upstream's browser demos use, at the same tag.
It must not build Emscripten (about 1 GB of SDK), and it must not commit 6 MB of binaries.
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

**What.** A test that imports every module of `lvgl_mpy_studio/core`, `gen`, `build`, `sim` and
`blocks` in a fresh interpreter, with `PySide6`, `serial` and `mpremote` blocked, and fails if
any import needs them. It also lists which modules import `subprocess`, `socket`, `select` or
`threading` at import time, against an allowlist, so a new one is noticed.

**Why.** The web IDE runs these packages in Pyodide, where Qt does not exist and processes and
sockets cannot be used. Today it works because `gen/fonts.py` imports `fontconv` (Qt) only when
a project has its own fonts. A test keeps that true.

**Where.** `tests/test_qt_free.py`. Today's allowlist, from a grep of `a45a85f`:
`gen/board_gen.py`, `build/compiler.py`, `build/preview.py`, `build/budget.py` and
`build/c_compiler.py` (`subprocess`), `build/release.py` (`subprocess`), `build/web.py`
(`threading`), `sim/session.py` (`socket`, `subprocess`, `threading`, `select`).

**Test.** The test itself. Adding `import PySide6` to a module of `core/` makes it fail.
