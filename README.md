# LVGL MPY Studio Web

The [LVGL MPY Studio](https://github.com/Copper-And-Code/lvgl-mpy-studio) IDE in the browser:
page designer, code editor, simulator, board over Web Serial and publishing a game for the web.
It runs alongside the desktop IDE and does not replace it.

> **Status: early.** Only the empty shell exists. See [`docs/status.md`](docs/status.md) for what
> works today, feature by feature, against the desktop IDE.

- Site: <https://copper-and-code.github.io/lvgl-mpy-studio-web/>
- Upstream: the desktop IDE is a git submodule in `upstream/`, pinned to a tag. Its Python core
  runs in the browser through Pyodide, unchanged.

## Browsers

Current Chrome, Edge, Firefox and Safari. The board, through Web Serial, works only in Chromium
browsers: Chrome, Edge and Chromebook.

## Development

```bash
git clone --recurse-submodules https://github.com/Copper-And-Code/lvgl-mpy-studio-web.git
cd lvgl-mpy-studio-web
pnpm install
pnpm dev          # http://localhost:5173/lvgl-mpy-studio-web/
pnpm lint && pnpm typecheck && pnpm test
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm e2e          # Chromium, Firefox and WebKit
```

Node 22.12 or later, and pnpm, at the version in `package.json`.

## Documents

- [`docs/status.md`](docs/status.md): parity with the desktop IDE
- [`docs/architecture.md`](docs/architecture.md): how the pieces fit
- [`docs/decisions.md`](docs/decisions.md): decisions and why
- [`docs/upstream-requests.md`](docs/upstream-requests.md): changes proposed to the desktop IDE

## Licence

The IDE is GPL-3.0-or-later, as upstream, whose core it runs: see [`LICENSE`](LICENSE). What
the IDE generates for its users (generated code, a game's web folder, the runtime files) keeps
upstream's MIT terms, as described in `upstream/LICENSING.md`. Third-party components are listed
in [`THIRD_PARTY.md`](THIRD_PARTY.md).
