// @ts-check
// The demonstration board's firmware, inside a sandboxed iframe with an opaque origin: the same
// MicroPython in WebAssembly as the simulator, behaving as a board behind a serial port. The page
// passes the bytes of the port both ways by postMessage; mpremote and upstream's DeviceSession in
// the Python worker talk to it as to any board: the friendly REPL, the raw REPL, Ctrl-C, Ctrl-D.
//
// What a board does and the browser's MicroPython does not, this page does:
// - a soft reset (Ctrl-D at an empty prompt) starts a new MicroPython: the page hands its flash
//   to the IDE, which loads this page again with it (demo-board.ts), as upstream's virtual board
//   starts its process again;
// - LVGL is served in the background, as a board's timer does, whenever the REPL waits;
// - raw-paste mode is answered "not supported", so mpremote uses the plain raw REPL.
// The Python side is upstream's: display_driver.py (contract 1) and lms_sandbox.py of
// runtime/program, the files the simulator gives a program without pages.

/** @typedef {[string, Uint8Array]} BoardFile */
/**
 * @typedef {{ type: 'start', mjs: string, wasm: ArrayBuffer, width: number, height: number,
 *   board: string, modules: string[], system: BoardFile[], flash: BoardFile[], raw: boolean,
 *   rebooted: boolean, frames: boolean }} Start
 */

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const FLASH = '/flash';
const FIRMWARE = '/firmware';
const OUTPUT_FLUSH_MS = 4;
/** display_driver.PERIOD_MS: how often LVGL is served while the REPL waits. */
const SERVICE_MS = 5;
const CTRL_A = 0x01;
const CTRL_B = 0x02;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const CTRL_E = 0x05;
const PYEXEC_FORCED_EXIT = 0x100;

const NO_MAIN_LOOP = 'emscripten_set_main_loop_timing: Cannot set timing mode';
const consoleError = console.error.bind(console);
console.error = (/** @type {unknown[]} */ ...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith(NO_MAIN_LOOP)) return;
  consoleError(...args);
};

/** @param {unknown} message @param {Transferable[]} [transfer] */
function post(message, transfer = []) {
  window.parent.postMessage(message, '*', transfer);
}

// ---- what the board prints: the bytes of its serial port ----
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
  post({ type: 'tx', data }, [data.buffer]);
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

// ---- the runtime ----
/** @type {any} */
let mp = null;
/** @type {any} */
let Module = null;
/** @type {any} */
let FS = null;
let frameSize = 0;
/** The REPL is raw: the board's pyexec_mode_kind, which a soft reset keeps. */
let raw = false;
/** Bytes of the port not yet given to the REPL. */
/** @type {number[]} */
let queue = [];
/** What runs now: a command of the REPL, LVGL's service, or nothing. */
/** @type {'repl' | 'service' | null} */
let running = null;
/** Ctrl-E and A of a raw-paste request, held until the Ctrl-A that ends it. */
/** @type {number[]} */
let held = [];
let resetting = false;
let started = false;

/** @param {string} code */
async function exec(code) {
  const length = Module.lengthBytesUTF8(code);
  const source = Module._malloc(length + 1);
  Module.stringToUTF8(code, source, length + 1);
  const result = Module._malloc(3 * 4);
  try {
    await Module.ccall(
      'mp_js_do_exec',
      'number',
      ['pointer', 'number', 'pointer'],
      [source, length, result],
      { async: true },
    );
  } finally {
    Module._free(source);
    Module._free(result);
  }
}

// What the Python side calls through the js module.
/** @type {any} */ (window).lmsBoardPresent = (/** @type {number} */ address) => {
  if (!frameSize || !Module) return;
  const pixels = Module.HEAPU8.slice(address, address + frameSize);
  post({ type: 'frame', pixels }, [pixels.buffer]);
};

/**
 * The firmware's start: modules of the profile that the browser's MicroPython has not are empty
 * modules, as a board's drivers that the IDE only checks for; lvsim through sys.modules, so that a
 * frame can be handed to the IDE; the display started, as a board's frozen driver; the flash as
 * "/", inside its folder; then boot.py.
 * @param {Start} start
 */
function bootCode(start) {
  const modules = JSON.stringify(start.modules.filter((name) => name !== 'display_driver'));
  return `
import sys, js
sys.path[:] = ["", "/lib", ${JSON.stringify(FIRMWARE)}]
import lvsim as _lvsim
try:
    from uctypes import addressof as _lms_address
except ImportError:
    _lms_address = None
class _LmsLvsim:
    def __getattr__(self, name):
        return getattr(_lvsim, name)
    def present(self):
        _lvsim.present()
        d = sys.modules.get("display_driver")
        b = getattr(d, "_buffer", None)
        if ${start.frames ? 'True' : 'False'} and _lms_address and b is not None:
            js.lmsBoardPresent(_lms_address(b))
sys.modules["lvsim"] = _LmsLvsim()
class _LmsModule:
    pass
for _name in ${modules}:
    try:
        __import__(_name)
    except ImportError:
        sys.modules[_name] = _LmsModule()
import display_driver
import os
from lms_sandbox import SandboxVfs
class _LmsErrno:
    """Emscripten's error numbers as a board's (Linux's, MicroPython's errno): mpremote reads
    ENOENT as 2 to tell a missing file."""
    CODES = {44: 2, 20: 17, 54: 20, 31: 21, 55: 39, 2: 13, 28: 22, 8: 9, 51: 28, 63: 1}
    def __init__(self, fs):
        self._fs = fs
    def __getattr__(self, name):
        method = getattr(self._fs, name)
        def call(*args):
            try:
                return method(*args)
            except OSError as e:
                code = e.errno if isinstance(e.errno, int) else None
                raise OSError(self.CODES.get(code, code)) from None
        return call
_lms_vfs = SandboxVfs(${JSON.stringify(FLASH)})
_lms_vfs._fs = _LmsErrno(_lms_vfs._fs)
os.umount("/")
os.mount(_lms_vfs, "/")
os.chdir("/")
sys.path[:] = ["", "/lib"]
def _lms_serve():
    d = sys.modules.get("display_driver")
    if d is not None and d.running():
        d._service(None)
del _name, os, SandboxVfs, _lms_vfs
`;
}

/** @param {string} name */
const runFile = (name) =>
  `try:\n open(${JSON.stringify(name)}).close()\nexcept OSError:\n pass\nelse:\n exec(open(${JSON.stringify(name)}).read(), {"__name__": "__main__"})\n`;

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

/** @param {string} folder @param {BoardFile[]} found */
function walkFlash(folder, found) {
  for (const name of FS.readdir(folder)) {
    if (name === '.' || name === '..') continue;
    const path = `${folder}/${name}`;
    if (FS.isDir(FS.stat(path).mode)) {
      found.push([`${path.slice(FLASH.length + 1)}/`, new Uint8Array()]);
      walkFlash(path, found);
    } else {
      found.push([path.slice(FLASH.length + 1), FS.readFile(path)]);
    }
  }
  return found;
}

/** @param {Start} start */
async function begin(start) {
  raw = start.raw;
  canvas.width = start.width;
  canvas.height = start.height;
  document.documentElement.style.setProperty('--ratio', `${start.width} / ${start.height}`);
  frameSize = start.frames ? start.width * start.height * 2 : 0;
  const mjs = URL.createObjectURL(new Blob([start.mjs], { type: 'text/javascript' }));
  const wasm = URL.createObjectURL(new Blob([start.wasm], { type: 'application/wasm' }));
  await import(/* @vite-ignore */ mjs);
  const load = /** @type {any} */ (globalThis).loadMicroPython;
  mp = await load({
    url: wasm,
    pystack: 64 * 1024,
    heapsize: 32 * 1024 * 1024,
    linebuffer: false,
    stdout: output,
    stderr: output,
  });
  Module = mp._module;
  Module.canvas = canvas;
  FS = mp.FS;
  FS.mkdir(FIRMWARE);
  for (const [name, data] of start.system) FS.writeFile(`${FIRMWARE}/${name}`, data);
  FS.writeFile(
    `${FIRMWARE}/lms_board.py`,
    `WIDTH = ${Number(start.width)}\nHEIGHT = ${Number(start.height)}\nBOARD = ${JSON.stringify(start.board)}\n`,
  );
  FS.mkdir(FLASH);
  for (const [name, data] of start.flash) {
    if (name.endsWith('/')) {
      makeFolders(FS, `${FLASH}/${name}x`);
      continue;
    }
    makeFolders(FS, `${FLASH}/${name}`);
    FS.writeFile(`${FLASH}/${name}`, data);
  }
  if (start.rebooted) say('MPY: soft reboot\r\n');
  running = 'repl';
  try {
    await exec(bootCode(start));
    await exec(runFile('boot.py'));
    // as a board: main.py only after a reset into the friendly REPL
    if (!raw) await exec(runFile('main.py'));
  } catch (error) {
    say(`${error instanceof Error ? error.message : String(error)}\r\n`);
  } finally {
    running = null;
  }
  mp.replInit();
  if (raw) mp.replProcessChar(CTRL_A);
  started = true;
  flushOutput();
  post({ type: 'ready' });
  setInterval(serve, SERVICE_MS);
  void pump();
}

/** LVGL served while the REPL waits, as a board's timer does. */
function serve() {
  if (!started || running || queue.length || resetting) return;
  running = 'service';
  exec('_lms_serve()')
    .catch(() => {})
    .finally(() => {
      running = null;
      if (queue.length) void pump();
    });
}

/** The bytes of the port into the REPL, one at a time; a command runs with Asyncify. */
async function pump() {
  if (!started || running || resetting) return;
  running = 'repl';
  try {
    while (queue.length) {
      const byte = /** @type {number} */ (queue.shift());
      // raw-paste mode (Ctrl-E, A, Ctrl-A): not here; mpremote then sends plain raw REPL input
      if (raw && (held.length || byte === CTRL_E)) {
        held.push(byte);
        const want = [CTRL_E, 0x41, CTRL_A];
        if (held.every((value, index) => value === want[index])) {
          if (held.length === want.length) {
            held = [];
            say('R\x00');
          }
          continue;
        }
        queue.unshift(...held.slice(1));
        const first = held[0];
        held = [];
        if (first !== undefined) await feed(first);
        continue;
      }
      if (await feed(byte)) return;
    }
  } finally {
    if (!resetting) running = null;
    flushOutput();
  }
}

/** One byte to the REPL; true when it asked for a soft reset. */
/** @param {number} byte */
async function feed(byte) {
  const executes = byte === CTRL_D || byte === 0x0d;
  const result = executes ? await mp.replProcessCharWithAsyncify(byte) : mp.replProcessChar(byte);
  if (byte === CTRL_A) raw = true;
  else if (byte === CTRL_B) raw = false;
  if (result & PYEXEC_FORCED_EXIT) {
    softReset();
    return true;
  }
  return false;
}

/** Ctrl-D at an empty prompt: the flash goes to the IDE, which starts this page again with it. */
function softReset() {
  resetting = true;
  flushOutput();
  /** @type {BoardFile[]} */
  let flash = [];
  try {
    flash = walkFlash(FLASH, []);
  } catch {
    // an empty flash
  }
  post(
    { type: 'reset', raw, flash, pending: new Uint8Array(queue) },
    flash.map(([, data]) => data.buffer),
  );
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.type === 'start' && !mp) {
    begin(message).catch((error) => {
      say(`\r\n${error?.message ?? error}\r\n`);
      flushOutput();
      post({ type: 'failed', message: String(error?.message ?? error) });
    });
  } else if (message?.type === 'sync') {
    // The port closes: the flash goes to the IDE, kept for the next connection. Null while
    // MicroPython is still loading, or when the flash cannot be read: the IDE then keeps what it
    // has, the flash this board was started with. An empty list would erase it.
    /** @type {BoardFile[] | null} */
    let flash = null;
    try {
      if (FS) flash = walkFlash(FLASH, []);
    } catch {
      // not read: nothing to hand over
    }
    post({ type: 'flash', flash }, flash ? flash.map(([, data]) => data.buffer) : []);
  } else if (message?.type === 'rx' && message.data instanceof Uint8Array) {
    for (const byte of message.data) {
      // Ctrl-C stops what runs, as on a board; LVGL's service is left alone
      if (byte === CTRL_C && running === 'repl' && Module) Module._mp_sched_keyboard_interrupt();
      queue.push(byte);
    }
    void pump();
  }
});

post({ type: 'hello' });

// a module of its own for the type checker; frame.js has names of the same kind
export {};
