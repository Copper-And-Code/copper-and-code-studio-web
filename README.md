# LVGL MPY Studio Web

The [LVGL MPY Studio](https://github.com/Copper-And-Code/lvgl-mpy-studio) IDE in the browser:
page designer, code editor, simulator, board over Web Serial and publishing a game for the web.
It runs alongside the desktop IDE and does not replace it.

> **Status: before its first release.** The designer, the code editor, the simulator, the board
> over Web Serial, the web version of a game, offline use and the Italian translation are there;
> [`docs/status.md`](docs/status.md) says, feature by feature, what is done against the desktop
> IDE and what was tested how. Real boards have been tried from the test bench, not yet by a
> person in a browser.

- Site: <https://copper-and-code.github.io/lvgl-mpy-studio-web/>
- Upstream: the desktop IDE is a git submodule in `upstream/`, pinned to a tag. Its Python core
  runs in the browser through Pyodide, unchanged.

## Browsers

Current Chrome, Edge, Firefox and Safari. The board, through Web Serial, works only in Chromium
browsers: Chrome and Edge on the PC, and Chromebooks.

After the first visit the IDE works offline, and the browser can install it as an app. A new
version is offered in the status bar, with Reload.

## Languages

English and Italian: Settings → Language. Without a choice, the browser's language decides. The
Italian is upstream's own catalogue, `translations/it.json`.

## Development

```bash
git clone --recurse-submodules https://github.com/Copper-And-Code/lvgl-mpy-studio-web.git
cd lvgl-mpy-studio-web
pnpm install
pnpm dev          # http://localhost:5173/lvgl-mpy-studio-web/
pnpm lint && pnpm typecheck && pnpm test
pnpm goldens      # upstream on the host, Python 3.11 or later
pnpm test:py      # upstream in Pyodide: goldens, audit, upstream's own tests
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm e2e          # Chromium, Firefox and WebKit
```

Node 22.12 or later, and pnpm, at the version in `package.json`.

## Documents

- [`docs/status.md`](docs/status.md): parity with the desktop IDE
- [`docs/architecture.md`](docs/architecture.md): how the pieces fit
- [`docs/decisions.md`](docs/decisions.md): decisions and why
- [`docs/upstream-requests.md`](docs/upstream-requests.md): changes proposed to the desktop IDE
- [`docs/capture.md`](docs/capture.md): the capture mode, for programs that record the IDE

## Licence

The IDE is GPL-3.0-or-later, as upstream, whose core it runs: see [`LICENSE`](LICENSE). What
the IDE generates for its users (generated code, a game's web folder, the runtime files) keeps
upstream's MIT terms, as described in `upstream/LICENSING.md`. Third-party components are listed
in [`THIRD_PARTY.md`](THIRD_PARTY.md).
