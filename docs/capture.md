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

| Option              | Effect                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `capture=1`         | Capture mode: `window.lmsCapture`, the events, the frames, and the presentation below. Without it every other option is ignored.           |
| `clock=manual`      | A project's clock moves only with `lmsCapture.step(ms)`. Without it the clock is real.                                                     |
| `seed=N`            | Every random source of the simulator starts from `N` (0 to 4294967295).                                                                    |
| `zoom=1.25`         | The scale of the IDE, from 0.5 to 4. The IDE still fills the window, without scrolling the page.                                           |
| `theme=light\|dark` | The theme, whatever the system's.                                                                                                          |
| `lang=it\|en`       | The language. Without it, English: never the browser's or the one the user chose.                                                          |
| `editor=plain`      | The code editors insert only what is typed: no automatic indent, no closing brackets, no completion list (Enter is a new line, Tab a tab). |

## Presentation

With `capture=1`:

- the workspace is in memory, empty at each load, and the settings too: the user's workspace,
  configuration, PC folders and settings are neither read nor written;
- no service worker is registered, so no "new version" bar appears;
- the status bar shows "Python 3.x ready" without the start-up time;
- the cursors of the code editor and of the terminals do not blink.
- the file chooser of Open, Save As and the others offers only the IDE's places (the workspace in
  memory, the examples): "A folder of the PC…" is not there, since the browser's own pickers can be
  neither driven nor filmed. A new project (File → New, New for a Board) needs no chooser at all;
  Save As puts it in the workspace in memory.

Not done yet: the browser's own tooltips (`title`) still show when the pointer rests on a control.

## `window.lmsCapture`

```ts
interface LmsCapture {
  version: 1;
  options: { enabled; clock; seed; zoom; theme; lang };
  onFrame(listener: (frame: CaptureFrame) => void): () => void; // returns unsubscribe
  onEvent(listener: (event: CaptureEvent) => void): () => void;
  frame(): CaptureFrame | null; // the last frame of the run
  onBoardFrame(listener: (frame: CaptureFrame) => void): () => void; // the demo board
  boardFrame(): CaptureFrame | null; // its last frame
  step(ms: number): Promise<CaptureFrame | null>; // clock=manual
  pointer(x: number, y: number, pressed: boolean): void; // clock=manual
  idle(timeoutMs?: number): Promise<void>; // default 30 000 ms
  settle(timeoutMs?: number): Promise<void>; // idle() without the work only scheduled
  // reading the IDE (phase 11)
  project(): CaptureProject | null;
  widgetBox(name: string): CaptureBox | null;
  editor(): CaptureEditor | null;
  editorPoint(line: number, column: number): { x: number; y: number } | null;
  paste(text: string): void;
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

### The demonstration board

Device → **Connect to Demo Board** (`menu-device.connect-to-demo-board`) connects to a board
without hardware: the browser's MicroPython in an iframe, as the project's board profile (its
resolution and the modules its firmware must have), behind an object with the shape of a Web
Serial port. Everything between is the IDE's own: BoardPort, the Python worker, mpremote and
upstream's DeviceSession, so the real flow shows: Connect, Device Information, Upload and Run,
Stop, Restart Interpreter (a soft reset keeps the flash), the Device Console and its REPL. It is
in every mode, not only in capture mode; it needs JSPI, as the board does (Chromium).

Its display is the centre tab **Demo board (simulated)** (`tab-demo-board`, the screen
`demo-board-screen`), with a line saying it is a simulated board. In capture mode each frame it
presents reaches `onBoardFrame`, as RGBA at the profile's resolution; `number` counts from 1 on
each page load. Its clock is real: `step()` and `pointer()` are the simulator's. Its flash lasts as
long as the page.

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

| `type`              | Details                                | When                                        |
| ------------------- | -------------------------------------- | ------------------------------------------- |
| `project-opened`    | `store`, `path`, `name`                | a project file was opened                   |
| `page-changed`      | `page` (id), `name`                    | the designer shows another page             |
| `simulator-started` | `mode`: `project`/`program`            | the simulator runs                          |
| `simulator-stopped` |                                        | Stop, or a new run replaces the old one     |
| `simulator-ended`   | `mode`                                 | the program ended by itself                 |
| `simulator-failed`  | `mode`                                 | the runtime could not start or crashed      |
| `upload-started`    |                                        | an upload to the board begins               |
| `upload-progress`   | `sent`, `total`, `name`                | bytes sent so far                           |
| `upload-finished`   |                                        | the upload ended, done or not               |
| `dialog-opened`     | `kind`, `title`, `fields`, `buttons`   | one of the IDE's dialogs opened             |
| `dialog-closed`     | `kind`, `title`                        | it closed                                   |
| `python-error`      | `file`, `line`, `message`, `traceback` | the simulator's program raised an exception |
| `output`            | `text`                                 | a line the program printed                  |
| `code-checked`      | `file`, `errors`                       | an editor's syntax check ended              |

The About box is not one of these dialogs.

`fields` and `buttons` of `dialog-opened` are the dialog's names after `dialog.field.` and
`dialog.button.` (see [Dialogs](#dialogs)).

`python-error`: `file` and `line` are those of the text a person would correct, as the Errors panel
maps them: `general`, `handler:<name>` or `module:<name>`, with the line of that text; a line of
the generated code that maps to none keeps the generated file's name and line. For Run Program
they are the program's own file and line. `message` is the exception's line (`ZeroDivisionError:
divide by zero`), `traceback` the whole traceback.

`output`: one event for each complete line, without its new line: what the Output panel shows of
a project, or the terminal of a program. A line still unfinished waits for its end.

`code-checked`: `file` as in `editor()`; `errors` are `{ line, message }`, the lines that the
editor marks red, empty when the code compiles.

### Reading the IDE

These read what the IDE holds now, at once, without a call to Python: after `idle()` they are
the result of the steps before.

```ts
interface CaptureProject {
  name: string;
  board: string | null; // the board profile's id
  resolution: [number, number];
  pages: { id: string; name: string; initial: boolean }[]; // initial: Set Initial Page
  page: string | null; // the id of the page the designer shows; null when another tab is in front
  widgets: {
    name: string;
    type: string;
    page: string; // the page's id
    parent: string | null; // the container's name, null on the page itself
    x: number; // on the page, not in the container: the canvas's own geometry
    y: number;
    width: number;
    height: number;
    handlers: Record<string, string>; // event -> handler, as the Events tab shows it
  }[];
  modules: string[]; // the Python modules, without .py
  selection: string[]; // the widgets selected on the page shown
  dirty: boolean; // changes not saved
}

interface CaptureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CaptureEditor {
  file: string; // general | handler:<name> | module:<name> | file:<path>
  text: string;
  caret: { line: number; column: number }; // both from 1
  selection: {
    from: { line: number; column: number };
    to: { line: number; column: number };
  } | null;
  visible: { first: number; last: number }; // the lines in view
  completion: { open: boolean; options: string[]; selected: number | null };
}
```

- `project()` is null only before the first project. Its widgets are those on the canvas; the
  non-visual components (timers and the like) are not in the list. Their geometry is the one the
  canvas draws: `x` and `y` in page pixels, a drag in progress not yet included.
- `widgetBox(name)` is where the canvas draws the widget, in the browser's viewport and CSS
  pixels, the coordinates of `page.mouse` in Playwright, at any zoom of the canvas or of the page
  (`zoom=`). Null when the widget's page is not the tab in front. The box may be outside the
  visible part of the canvas: scroll it first.
- `editor()` is the editor of the tab in front: the Code tab (`general` is its general code,
  `handler:<name>` a handler, `module:<name>` a Python module) or a file tab (`file:<path>`).
  Null when another tab is in front.
- `editorPoint(line, column)` is the middle of the caret at that place of the text, in the
  viewport: a click there puts the caret there. Null when the line is not in view.
- `paste(text)` puts the text at the caret, in place of the selection, as Ctrl+V with that text on
  the clipboard: one undo step, the same indentation (none is added), without the system clipboard.
  It throws when no editor is in front or it is read-only (the simulator runs).

### Typing in the editor

The editors help as a person sees them help. Typed key by key, each keystroke leads to the same
text in every take; the rules:

- **Enter** keeps the indentation of the line; after a line ending in `:` it indents by four more
  spaces. Between a bracket and the one the editor closed for it, the closing one goes to a line
  of its own.
- **Backspace** in the spaces at the start of a line removes up to the previous multiple of four.
- **Brackets and quotes**: typing `(`, `[`, `{`, `'` or `"` also inserts the closing one after
  the caret; typing the closing one right before it moves over it instead of adding one. So the
  text typed as written, closing brackets included, gives that text.
- Typing `else:`, `elif`, `except` or `finally:` at a deeper indentation moves the line to the
  one of its `if` or `try`.
- **The completion list** opens after the second letter of a name, and right after a dot, when
  there is something to offer; it updates with each letter and closes on any other character.
  While it is open, **Enter** inserts the selected option (the first, unless the arrows moved),
  **Escape** closes it, **Tab** indents the line as without it, and the arrows move in it.

In capture mode the list opens as soon as its options are there, with no delay, and `idle()` and
`settle()` wait for them; so after either the list is open or not the same way in every take. A
driver that types without waiting between keys may see it open later than the key it belongs to:
before Enter, Tab or Escape, call `settle()` and read `editor().completion`.

With `editor=plain` none of this happens: the text is exactly the keys typed.

### Idle

`idle()` resolves when, for three animation frames in a row, no call to Python is waiting, the
designer is not drawing a page or about to, the RAM budget is not being measured or about to (it
waits 1.5 s after a change, as on the desktop), no editor waits for its completion list, no syntax
check is running, and no CSS animation runs. It does not wait for the syntax check an editor
starts 0.5 s (a file tab: 0.8 s) after the last change: `code-checked` says when it ends. It replaces waits by time.
A running simulator does not count as work. It rejects after `timeoutMs`.

`settle()` is `idle()` without the work that is only scheduled: it waits for Python, the
completion list, a page being drawn, a measure of the budget or a syntax check that runs, but not
for the budget's measure due 1.5 s after the last change nor the drawing about to start. Between
the keys of a typed text it takes a few frames, where `idle()` would take the 1.5 s of the budget
at every key; `idle()` after the text then waits for the rest.

## Stable names

`data-capture` attributes, the same in every language. Shadow roots are open, so a CSS selector
such as Playwright's `[data-capture="toolbox"]` finds them.

| Name                                                                 | Control                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `menu-<menu>`                                                        | a menu of the menu bar: `menu-file`, `menu-run`, …                                 |
| `menu-<menu>.<item>[.<item>]`                                        | its items: `menu-run.start`, `menu-file.open-example.fifteen`                      |
| `tab-<id>`                                                           | a tab of the centre: `tab-code`, a page's tab                                      |
| `toolbox`                                                            | the Toolbox                                                                        |
| `project-tree`                                                       | the project tree                                                                   |
| `designer-canvas`                                                    | the designer's canvas                                                              |
| `designer-widget.<name>`                                             | a widget drawn on the canvas                                                       |
| `designer-handle.<dir>`                                              | a resize handle of the selected widget: `nw`, `n`, `ne`, `e`, `se`, `s`, `sw`, `w` |
| `toolbox.<type>`                                                     | an entry of the Toolbox: `toolbox.label`, `toolbox.button`                         |
| `tree.page.<page name>`                                              | a page in the project tree                                                         |
| `tree.widget.<widget name>`                                          | a widget in the project tree                                                       |
| `tree.modules`, `tree.module.<name>`                                 | the Python Modules branch, a module (without `.py`)                                |
| `tree.file.<path>`                                                   | a file or folder of the Files panel, by its path in the folder                     |
| `context-menu.<item>`                                                | an item of a context menu (the tree's, the Files panel's)                          |
| `properties-tab.properties`, `properties-tab.events`                 | the two tabs of the Properties panel                                               |
| `event.<event>`, `event.<event>.handler`                             | a row of the Events tab and its Handler cell                                       |
| `code.object`, `code.procedure`                                      | the Object and Procedure lists of the Code tab                                     |
| `code.new-python-module`, `code.rename-module`, `code.delete-module` | the Code tab's buttons                                                             |
| `properties`, `events`                                               | the Properties and Events tables                                                   |
| `code-editor`                                                        | the editor of the Code tab                                                         |
| `file-editor`                                                        | the editor of a file tab                                                           |
| `output`                                                             | the Output panel                                                                   |
| `sim-screen`, `sim-terminal`                                         | the simulator's screen and its terminal                                            |
| `device-console`                                                     | the Device Console                                                                 |
| `upload-progress`                                                    | the upload's progress dialog                                                       |
| `dialog`                                                             | the IDE's dialog                                                                   |
| `budget`, `python-status`                                            | the status bar's Flash · RAM and Python texts                                      |

A property's editor in the Properties table is `[data-property="<key>"]`, inside
`[data-capture="properties"]`: `text`, `x`, `width`, … as the project file names them, and `Name`
for the widget's name. A value is typed in it and given with Enter (or Tab); a checkbox is
clicked; the `…` button of an
image or a font property is `[data-choose="<key>"]`.

The Events tab has no field to type a handler's name in, as on the desktop: a double click on the
row (`event.<event>`), or Enter on it, makes the handler with its usual name (`<widget>_<event>`,
in lower case), opens it in the Code tab and shows the name in the row's Handler cell.

A menu name is its English text in lower case, with every run of other characters as one dash:
"Run Program…" is `run-program`, "Upload Project" in Device is `menu-device.upload-project`. Start
and Stop are `menu-run.start` and `menu-run.stop`.

### Dialogs

Every control of a dialog has a name, the same in every language:

- `dialog.field.<name>` on each field: a form's own name for it (`width`, `mode`), or else its
  label by the menu rule ("Name:" is `name`, "Board Profile" is `board-profile`). A choice of a
  group of radio buttons is `dialog.field.<group>.<choice>`.
- `dialog.button.<id>` on each button, its text by the menu rule: `ok`, `cancel`, `save`,
  `discard`, `yes`, `no`, `apply`, `new-folder`, … In the file chooser the places of the path are
  `dialog.button.folder` (the top) and `dialog.button.folder.<path>`, its files and folders
  `dialog.button.entry.<name>` and `..` is `dialog.button.entry.parent`.
- Two controls that would have the same name get `-2`, `-3`, … in the order of the dialog.

The dialogs a new project goes through: File → New and Open… may first ask "Save changes?"
(`save`, `discard`, `cancel`); New for a Board is a submenu
(`menu-file.new-for-a-board.esp32-4848s040-480-480`); Project → Add Page asks nothing; Rename Page,
New Python Module… and New File… ask a name (`dialog.field.name`, or
`dialog.field.module-name-without-py`); Save As… is the file chooser (`dialog.field.place`,
`dialog.field.name`, `dialog.button.save`); Project Settings… has `dialog.field.preset`,
`dialog.field.width`, `dialog.field.height`, `dialog.field.board-profile`, `dialog.button.apply`.

## Not yet

- The browser's tooltips in capture mode.
- `machine.Timer` and a program without pages under the manual clock.

## Versions

- **1** (phase 10): first version; later in the same version, the demonstration board's
  `onBoardFrame` and `boardFrame` (additions only).
- **1**, phase 11 (additions only): `project()`, `widgetBox()`, `editor()`, `editorPoint()`,
  `paste()`, `settle()`; the events `python-error`, `output` and `code-checked`; `fields` and `buttons` of
  `dialog-opened`; the names of dialogs, the project tree, the Events tab, the Toolbox, the Code
  tab and the resize handles; `editor=plain`; the completion list without delays in capture mode,
  waited for by `idle()`, which also waits for a running syntax check.
- **1**, the rename to Copper and Code Studio (upstream `v0.8.0`): nothing of the contract moved
  (`window.lmsCapture`, its fields, events and query parameters). One name follows its English
  label, as every menu item does: the About item of the Help menu is now
  `menu-help.about-copper-and-code-studio` (it was `menu-help.about-lvgl-mpy-studio`).
- **1**, a fix (2026-11-22): with `zoom=` other than 1 the IDE was that many times as tall as the
  window, and the page scrolled, because a CSS zoom scales `vh` and `vw` too (the limits of the
  dialogs and menus as well); now it fills the window at every zoom.

Tested by `tests/e2e/capture.spec.ts` on Chromium, Firefox and WebKit: with
`capture=1&clock=manual&seed=1` the fifteen runs 60 steps of 33 ms, with Play tapped, and two runs
in two pages give the same 60 frames byte for byte.
