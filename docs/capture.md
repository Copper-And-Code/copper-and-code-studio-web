# Capture contract

A program outside the IDE, such as a video recorder driving the browser with Playwright, can
follow what the IDE does, take the simulator's frames and make its runs repeatable. It talks to
the IDE through one object, `window.lmsCapture`, and through the `data-capture` names of the
controls. Nothing of this exists unless the page's URL has `?capture=1`: in normal use the IDE
does not change.

**Version 1.** `lmsCapture.version` is `1`. A caller pins the version it was written for and
checks it. Adding a name, an event or a URL option keeps the version; removing or changing one
raises it, and the change is written under [Versions](#versions).

## URL options

| Option              | Effect                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `capture=1`         | Capture mode: `window.lmsCapture`, the events, the frames, and the presentation below. Without it every other option is ignored. |
| `clock=manual`      | A project's clock moves only with `lmsCapture.step(ms)`. Without it the clock is real.                                           |
| `seed=N`            | Every random source of the simulator starts from `N` (0 to 4294967295).                                                          |
| `zoom=1.25`         | The scale of the IDE, from 0.5 to 4.                                                                                             |
| `theme=light\|dark` | The theme, whatever the system's.                                                                                                |
| `lang=it\|en`       | The language. Without it, English: never the browser's or the one the user chose.                                                |

## Presentation

With `capture=1`:

- the workspace is in memory, empty at each load, and the settings too: the user's workspace,
  configuration, PC folders and settings are neither read nor written;
- no service worker is registered, so no "new version" bar appears;
- the status bar shows "Python 3.x ready" without the start-up time;
- the cursors of the code editor and of the terminals do not blink.

Not done yet: the browser's own tooltips (`title`) still show when the pointer rests on a control.

## `window.lmsCapture`

```ts
interface LmsCapture {
  version: 1;
  options: { enabled; clock; seed; zoom; theme; lang };
  onFrame(listener: (frame: CaptureFrame) => void): () => void; // returns unsubscribe
  onEvent(listener: (event: CaptureEvent) => void): () => void;
  frame(): CaptureFrame | null; // the last frame of the run
  step(ms: number): Promise<CaptureFrame | null>; // clock=manual
  pointer(x: number, y: number, pressed: boolean): void; // clock=manual
  idle(timeoutMs?: number): Promise<void>; // default 30 000 ms
}

interface CaptureFrame {
  width: number; // the display's own resolution
  height: number;
  number: number; // 1, 2, … in each run
  pixels: Uint8ClampedArray; // RGBA, width × height × 4, opaque
}
```

The object is there once the shell has started; `window.lmsStudio.started` resolves when the first
project is ready.

### Frames

Every frame the program presents in the simulator, a project or a program without pages, reaches
`onFrame` as RGBA at the display's resolution. It is the runtime's frame buffer (RGB565) converted
as upstream's `build/visual.py` does, so the canvas never has to be read from outside. A frame comes
only when LVGL redraws something: a still screen sends none.

### The manual clock

With `clock=manual`, a project's main loop waits at `display_driver.poll()` until the next step.
`step(ms)` moves the clock by `ms`, lets the loop run once (LVGL's tick, its timers, the drawing)
and resolves when the loop is back at its poll, with the last frame. One step at a time: a second
`step()` before the first resolves is refused.

What the clock covers: LVGL's tick and timers, `lv.tick_get()`, `time.ticks_ms()` and the other
`time` functions, which read the page's clocks; `time.sleep()`, `sleep_ms()` and `sleep_us()` move
the clock instead of waiting. Not covered: `machine.Timer`. A program without pages (Run Program)
keeps the real clock; only its frames and its seed follow the capture options.

`step()` is refused without the manual clock, when no project runs, and when the run ends, fails or
is stopped while a step waits.

`pointer(x, y, pressed)` sets the pointer the project reads from the next step on, in display
pixels: the same press at the same step, every time. A tap is a press for at least one step, then a
release. The real mouse on the simulator works too, but its timing is the browser's.

### The seed

With `seed=N`, `crypto.getRandomValues()` and `Math.random()` of the simulator's page give a fixed
sequence (mulberry32 from `N`), so MicroPython's `random` starts from the same state, and
`random.seed(N)` is called before the program. A game that seeds itself from `lv.tick_get()`, as the
fifteen does, is repeatable with the manual clock.

### Events

`onEvent` gets `{ type, seq, … }`, `seq` counting from 1 on each load:

| `type`              | Details                     | When                                    |
| ------------------- | --------------------------- | --------------------------------------- |
| `project-opened`    | `store`, `path`, `name`     | a project file was opened               |
| `page-changed`      | `page` (id), `name`         | the designer shows another page         |
| `simulator-started` | `mode`: `project`/`program` | the simulator runs                      |
| `simulator-stopped` |                             | Stop, or a new run replaces the old one |
| `simulator-ended`   | `mode`                      | the program ended by itself             |
| `simulator-failed`  | `mode`                      | the runtime could not start or crashed  |
| `upload-started`    |                             | an upload to the board begins           |
| `upload-progress`   | `sent`, `total`, `name`     | bytes sent so far                       |
| `upload-finished`   |                             | the upload ended, done or not           |
| `dialog-opened`     | `kind`, `title`             | one of the IDE's dialogs opened         |
| `dialog-closed`     | `kind`, `title`             | it closed                               |

The About box is not one of these dialogs.

### Idle

`idle()` resolves when, for three animation frames in a row, no call to Python is waiting, the
designer is not drawing a page or about to, the RAM budget is not being measured or about to (it
waits 1.5 s after a change, as on the desktop), and no CSS animation runs. It replaces waits by time.
A running simulator does not count as work. It rejects after `timeoutMs`.

## Stable names

`data-capture` attributes, the same in every language. Shadow roots are open, so a CSS selector
such as Playwright's `[data-capture="toolbox"]` finds them.

| Name                          | Control                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `menu-<menu>`                 | a menu of the menu bar: `menu-file`, `menu-run`, …            |
| `menu-<menu>.<item>[.<item>]` | its items: `menu-run.start`, `menu-file.open-example.fifteen` |
| `tab-<id>`                    | a tab of the centre: `tab-code`, a page's tab                 |
| `toolbox`                     | the Toolbox                                                   |
| `project-tree`                | the project tree                                              |
| `designer-canvas`             | the designer's canvas                                         |
| `properties`, `events`        | the Properties and Events tables                              |
| `code-editor`                 | the editor of the Code tab                                    |
| `file-editor`                 | the editor of a file tab                                      |
| `output`                      | the Output panel                                              |
| `sim-screen`, `sim-terminal`  | the simulator's screen and its terminal                       |
| `device-console`              | the Device Console                                            |
| `upload-progress`             | the upload's progress dialog                                  |
| `dialog`                      | the IDE's dialog                                              |
| `budget`, `python-status`     | the status bar's Flash · RAM and Python texts                 |

A menu name is its English text in lower case, with every run of other characters as one dash:
"Run Program…" is `run-program`, "Upload Project" in Device is `menu-device.upload-project`. Start
and Stop are `menu-run.start` and `menu-run.stop`.

## Not yet

- A demonstration board without hardware (request point 6).
- The browser's tooltips in capture mode.
- `machine.Timer` and a program without pages under the manual clock.

## Versions

- **1** (phase 10): first version.

Tested by `tests/e2e/capture.spec.ts` on Chromium, Firefox and WebKit: with
`capture=1&clock=manual&seed=1` the fifteen runs 60 steps of 33 ms, with Play tapped, and two runs
in two pages give the same 60 frames byte for byte.
