# Upstream in Pyodide: the audit

Upstream `v0.7.0`, Pyodide 314.0.7 (Python 3.14). Checked by `tests/py/audit.test.ts`, which
imports every module of the bundle in Pyodide.

## Imports

Every module of `lvgl_mpy_studio/{core,gen,build,sim,blocks}` and `platform.py` imports in
Pyodide, and none of them loads PySide6, qtawesome, pyserial or mpremote. `subprocess`, `socket`
and `threading` exist in Pyodide and import fine; what fails is **using** them: starting a
process raises `OSError: [Errno 138] emscripten does not support processes`, starting a thread
raises `RuntimeError: can't start new thread`.

The bundle carries the whole of `build/`, `release.py` and `c_compiler.py` included:
`build/web.py`, which phase 7 needs, imports `release.py` when it loads, and `release.py`
imports `c_compiler.py` and `gen/gen_c.py`. They are about 100 kB and the web IDE never calls
the C build.

## Where upstream needs a process, a socket or a thread

| Upstream                                                 | What it starts                                           | In the web IDE                                                                                                                                                                  | Phase |
| -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `build/compiler.py` `compile_python`                     | native `mpy-cross`                                       | not called; the web compiler is `mpy-cross.wasm` (upstream request 2)                                                                                                           | 4     |
| `gen/board_gen.py` `_validate_sources`, `_bytecode_file` | native `mpy-cross`, only if the file exists              | skipped, as upstream does when `mpy-cross` is missing: the sources are checked by CPython's `compile()` only. Same result as the host goldens, which have no `mpy-cross` either | 4, 6  |
| `build/preview.py` `render_with_log`, `build/visual.py`  | the simulator runtime, through `platform.run_background` | the design-only renderer in the simulator iframe; the PNG and geometry come back to Python in upstream's shape                                                                  | 5     |
| `build/budget.py` `_measure_ram`                         | the simulator runtime                                    | the same iframe, measuring                                                                                                                                                      | 5     |
| `sim/session.py`                                         | the runtime, a TCP socket, two threads                   | the iframe host; `sim/protocol.py` and `sim/script.py` are used as they are                                                                                                     | 3     |
| `build/web.py` `serve`                                   | an HTTP server in a thread                               | not needed: the site is the server. `build_web` itself is pure and runs as is                                                                                                   | 7     |
| `build/release.py`, `build/c_compiler.py`                | the C compiler, the release build                        | left out by the owner's decision                                                                                                                                                | —     |
| `platform.run_background`                                | any process                                              | reached only through the rows above                                                                                                                                             | —     |

None of these needs a change upstream today: the web IDE does not call them, or calls the pure
part and does the rest in TypeScript. A change would be proposed in `upstream-requests.md` when
an adapter needs one.

## Generation

`generate_project` and `export_board` run unchanged and give byte-identical files and identical
warnings for all 9 example projects (`tests/py/goldens.test.ts`, and in the browser
`tests/e2e/python.spec.ts`).
