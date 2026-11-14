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
- **Test packages come from the network at test time**: pytest from Pyodide's package index,
  pyserial, mpremote and hypothesis from PyPI through micropip, at exact versions. They are not
  part of the site.
