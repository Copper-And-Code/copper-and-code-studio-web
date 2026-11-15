// @ts-check
// The simulator's page, inside a sandboxed iframe with an opaque origin: MicroPython in
// WebAssembly with LVGL on the canvas. Stop drops the iframe, so a crash or a program stuck in a
// loop never outlives it. The IDE sends everything by postMessage: the runtime, the files, the
// keys; the page sends back what the program prints and, for a program, its flash.
//
// It does what upstream's runtime/web/lms_web.js (a project with pages) and lms_program.js (a
// program without pages) do, with postMessage in place of fetch and of the browser console.
// The Python side is upstream's, unchanged: lms_web_boot.py, display_driver.py, lms_sandbox.py.
// docs/decisions.md, phase 3, says why this page does not load those two files as they are.

/** @typedef {[string, Uint8Array]} SimFile */
/**
 * @typedef {{ type: 'start', mode: 'project' | 'program' | 'frame', mjs: string,
 *   wasm: ArrayBuffer, width: number, height: number, board: string, entry: string,
 *   system: SimFile[], files: SimFile[] }} Start
 */

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const typing = /** @type {HTMLTextAreaElement} */ (document.getElementById('typing'));
const FLASH = '/flash';
const FLASH_SYNC_MS = 1000;
const OUTPUT_FLUSH_MS = 16;

// The runtime's SDL sets the swap interval when it creates the window, before a main loop
// exists, and emscripten logs it as an error each time: harmless, and nothing here can change
// it (upstream request 10). Only that line is dropped; every other error still shows.
const NO_MAIN_LOOP = 'emscripten_set_main_loop_timing: Cannot set timing mode';
const consoleError = console.error.bind(console);
console.error = (/** @type {unknown[]} */ ...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith(NO_MAIN_LOOP)) return;
  consoleError(...args);
};

let keys = '';
let running = false;
/** @type {'project' | 'program' | 'frame' | null} */
let mode = null;
/** @type {any} */
let FS = null;
/** @type {Map<string, number>} what the IDE has of the flash: path → mtime */
let known = new Map();

// What lms_web_boot.py reads: the keys typed since the last call.
/** @type {any} */ (window).lmsTake = () => {
  const taken = keys;
  keys = '';
  return taken;
};

/** @param {unknown} message @param {Transferable[]} [transfer] */
function post(message, transfer = []) {
  window.parent.postMessage(message, '*', transfer);
}

// ---- output: bytes, sent in batches ----
/** @type {number[]} */
let pending = [];
/** @type {ReturnType<typeof setTimeout> | undefined} */
let flushTimer;

function flushOutput() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pending.length) return;
  const data = new Uint8Array(pending);
  pending = [];
  post({ type: 'output', data }, [data.buffer]);
}

/** @param {Uint8Array} bytes */
function output(bytes) {
  for (const byte of bytes) pending.push(byte);
  if (pending.length > 8192) flushOutput();
  else flushTimer ??= setTimeout(flushOutput, OUTPUT_FLUSH_MS);
}

/** @param {string} text */
function say(text) {
  output(new TextEncoder().encode(text));
}

// ---- keys of a program: the bytes xterm sends, as upstream's lms_program.js ----
/** @type {Record<string, string>} */
const SPECIAL = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
};
/** @type {Record<string, string>} */
const CONTROL = { '[': '\x1b', '\\': '\x1c', ']': '\x1d', ' ': '\x00' };

/** @param {KeyboardEvent} event */
function keyBytes(event) {
  if (event.key === 'Tab' && event.shiftKey) return '\x1b[Z';
  if (event.key in SPECIAL) return SPECIAL[event.key];
  if (event.ctrlKey && !event.altKey && event.key.length === 1) {
    const letter = event.key.toUpperCase();
    if (letter >= 'A' && letter <= 'Z') return String.fromCharCode(letter.charCodeAt(0) - 64);
    if (event.key in CONTROL) return CONTROL[event.key];
  }
  if (!event.ctrlKey && !event.metaKey && event.key.length === 1) {
    return (event.altKey ? '\x1b' : '') + event.key;
  }
  return '';
}

// A program reads keys from its serial port; a project gets them from SDL, inside the runtime.
document.addEventListener(
  'keydown',
  (event) => {
    // F5 and Shift+F5 are the IDE's Start and Stop, wherever the focus is.
    if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      post({ type: 'shortcut', shift: event.shiftKey });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (mode !== 'program' || !running || event.isComposing) return;
    if (event.ctrlKey && event.shiftKey && (event.key === 'V' || event.key === 'C')) return;
    const data = keyBytes(event);
    if (data) {
      keys += data;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
document.addEventListener('paste', (event) => {
  if (mode !== 'program' || !running) return;
  keys += (event.clipboardData?.getData('text') ?? '').replace(/\r?\n/g, '\r');
  event.preventDefault();
});
// Phones show a keyboard only for a text field: a touch on the screen focuses a hidden one.
canvas.addEventListener('pointerdown', () => {
  if (mode === 'program') typing.focus({ preventScroll: true });
});
typing.addEventListener('input', () => {
  if (mode === 'program' && running && typing.value) keys += typing.value;
  typing.value = '';
});

// ---- the flash of a program, kept by the IDE between runs ----
/** @param {string} folder @param {Map<string, number>} found */
function walkFlash(folder, found) {
  for (const name of FS.readdir(folder)) {
    if (name === '.' || name === '..') continue;
    const path = `${folder}/${name}`;
    const stat = FS.stat(path);
    if (FS.isDir(stat.mode)) walkFlash(path, found);
    else found.set(path.slice(FLASH.length + 1), Number(stat.mtime));
  }
  return found;
}

function syncFlash() {
  if (mode !== 'program' || !FS) return;
  let now;
  try {
    now = walkFlash(FLASH, new Map());
  } catch {
    return;
  }
  /** @type {SimFile[]} */
  const changed = [];
  for (const [path, mtime] of now) {
    if (known.get(path) !== mtime) changed.push([path, FS.readFile(`${FLASH}/${path}`)]);
  }
  const removed = [...known.keys()].filter((path) => !now.has(path));
  known = now;
  if (changed.length || removed.length) {
    post(
      { type: 'flash', changed, removed },
      changed.map(([, data]) => data.buffer),
    );
  }
}

// machine.reset() reloads this page: what the program wrote must reach the IDE first.
window.addEventListener('pagehide', () => {
  syncFlash();
  flushOutput();
});

// ---- start ----
/** @param {any} fs @param {string} path */
function makeFolders(fs, path) {
  let current = '';
  for (const part of path.split('/').slice(0, -1).filter(Boolean)) {
    current += '/' + part;
    try {
      fs.mkdir(current);
    } catch {
      // already there
    }
  }
}

/** @param {string} code @param {any} Module */
async function run(code, Module) {
  const length = Module.lengthBytesUTF8(code);
  const source = Module._malloc(length + 1);
  Module.stringToUTF8(code, source, length + 1);
  const result = Module._malloc(3 * 4);
  // async: the program waits for keys and frames, and while it waits the browser runs (Asyncify).
  await Module.ccall(
    'mp_js_do_exec',
    'number',
    ['pointer', 'number', 'pointer'],
    [source, length, result],
    {
      async: true,
    },
  );
}

// The first frame, as upstream's build/preview.py takes it from the runtime (LVSIM_TICK_MS=0,
// LVSIM_FRAMES=1, LVSIM_DUMP): LVGL's clock stands still, the frame buffer is written after the
// first complete frame, and the main loop ends at the next poll.
const FIRST_FRAME = `
import display_driver as _d
_d.tick = lambda: 0
_flush, _poll, _done = _d._flush, _d.poll, []
def _first(display, area, color_p):
    _flush(display, area, color_p)
    if display.flush_is_last() and not _done:
        with open("/frame.raw", "wb") as f:
            f.write(_d._buffer)
        _done.append(1)
_d._flush = _first
_d.poll = lambda: not _done and _poll()
`;

/** @param {string} body */
const guarded = (body) =>
  `try:\n${body.replace(/^/gm, ' ')}\nexcept BaseException as e:\n import sys\n sys.print_exception(e)\n`;

/** @param {Start} start */
async function begin(start) {
  mode = start.mode;
  canvas.width = start.width;
  canvas.height = start.height;
  document.documentElement.style.setProperty('--ratio', `${start.width} / ${start.height}`);
  const mjs = URL.createObjectURL(new Blob([start.mjs], { type: 'text/javascript' }));
  const wasm = URL.createObjectURL(new Blob([start.wasm], { type: 'application/wasm' }));
  await import(/* @vite-ignore */ mjs);
  const load = /** @type {any} */ (globalThis).loadMicroPython;
  const mp = await load({
    url: wasm,
    pystack: 64 * 1024,
    heapsize: (start.mode === 'program' ? 32 : 24) * 1024 * 1024,
    linebuffer: false,
    stdout: output,
    stderr: output,
  });
  const Module = mp._module;
  Module.canvas = canvas;
  FS = mp.FS;
  let code;
  if (start.mode === 'program') {
    for (const [name, data] of start.system) FS.writeFile('/' + name, data);
    FS.writeFile(
      '/lms_board.py',
      `WIDTH = ${Number(start.width)}\nHEIGHT = ${Number(start.height)}\n` +
        `BOARD = ${JSON.stringify(start.board)}\nENTRY = ${JSON.stringify(start.entry)}\n`,
    );
    FS.mkdir(FLASH);
    for (const [name, data] of start.files) {
      makeFolders(FS, `${FLASH}/${name}`);
      FS.writeFile(`${FLASH}/${name}`, data);
    }
    known = walkFlash(FLASH, new Map());
    setInterval(syncFlash, FLASH_SYNC_MS);
    // The boot runs a REPL after the program, so it ends only on an error, which Python prints.
    code = guarded('import lms_web_boot');
  } else {
    for (const [name, data] of start.files) {
      makeFolders(FS, '/' + name);
      FS.writeFile('/' + name, data);
    }
    code = guarded(`${start.mode === 'frame' ? FIRST_FRAME : ''}import main\nmain.main()`);
  }
  running = true;
  post({ type: 'running' });
  if (start.mode === 'program') typing.focus({ preventScroll: true });
  await run(code, Module);
  running = false;
  syncFlash();
  flushOutput();
  if (start.mode === 'frame') {
    let pixels = null;
    try {
      pixels = FS.readFile('/frame.raw');
    } catch {
      // no frame: the output says why
    }
    post({ type: 'frame', pixels }, pixels ? [pixels.buffer] : []);
  }
  post({ type: 'ended' });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.type === 'start' && mode === null) {
    begin(message).catch((error) => {
      running = false;
      say(`\r\n${error?.message ?? error}\r\n`);
      flushOutput();
      post({ type: 'failed', message: String(error?.message ?? error) });
    });
  } else if (message?.type === 'keys' && typeof message.data === 'string') {
    if (running && mode === 'program') keys += message.data;
  } else if (message?.type === 'sync') {
    syncFlash();
    flushOutput();
    post({ type: 'synced' });
  } else if (message?.type === 'focus') {
    (mode === 'program' ? typing : canvas).focus({ preventScroll: true });
  }
});

post({ type: 'hello' });
