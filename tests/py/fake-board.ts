// A scripted MicroPython board for the transport tests: the REPL of MicroPython's pyexec.c
// (friendly, raw and raw-paste), with the Python it receives run by a Pyodide of its own in a
// MicroPython-like world: a file system in memory, os.ilistdir and os.statvfs, machine,
// gc.mem_free, sys.implementation 'micropython', and the lvgl and display_driver modules of a
// board profile. It is enough for upstream's DeviceSession and mpremote; it is not MicroPython.
import type { PyodideInterface } from 'pyodide';
import type { Wire } from '../../src/board/link.ts';
import { startPyodide } from './pyodide-node.mjs';

export interface BoardSetup {
  /** display_driver.WIDTH and HEIGHT. */
  width: number;
  height: number;
  touch?: boolean;
  /** sys.implementation.version and lvgl.version_info(). */
  micropython?: [number, number, number];
  lvgl?: [number, number, number];
  /** sys.implementation._mpy; null: no bytecode, the app is uploaded as source (it can run here). */
  mpy?: number | null;
  /** A firmware shell in front of the REPL that takes one Ctrl-C to leave, as some ESP32 boards. */
  shell?: boolean;
  /** Bytes the board takes per raw-paste window (0: no raw-paste, as old firmware). */
  window?: number;
  /** The Montserrat sizes of the firmware. */
  fonts?: number[];
}

const BOARD_PY = String.raw`
import builtins, errno, io, sys as _sys, types, traceback, contextlib, binascii, hashlib, json

ROOT = '/board'
import os as _os
_os.makedirs(ROOT, exist_ok=True)

def _real(path):
    path = str(path)
    if not path.startswith('/'):
        path = _cwd[0].rstrip('/') + '/' + path
    parts = []
    for part in path.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            if parts: parts.pop()
            continue
        parts.append(part)
    return ROOT + '/' + '/'.join(parts)

_cwd = ['/']

# MicroPython's numbers are Linux's; Pyodide's file system gives emscripten's.
MP_ERRNO = {'EPERM': 1, 'ENOENT': 2, 'EIO': 5, 'EBADF': 9, 'EACCES': 13, 'EEXIST': 17, 'ENODEV': 19,
            'ENOTDIR': 20, 'EISDIR': 21, 'EINVAL': 22, 'ENOSPC': 28, 'ENOTEMPTY': 39}
MP_NAMES = {number: name for name, number in MP_ERRNO.items()}

def _oserror(exc):
    name = errno.errorcode.get(getattr(exc, 'errno', None) or 0, 'EIO')
    error = OSError(MP_ERRNO.get(name, 5), name)
    error.mp = True
    return error

def _wrap(function):
    def call(*args):
        try:
            return function(*args)
        except OSError as exc:
            raise _oserror(exc) from None
    return call

board_os = types.ModuleType('os')
board_os.listdir = _wrap(lambda path='': sorted(_os.listdir(_real(path or _cwd[0]))))
def _ilistdir(path=''):
    real = _real(path or _cwd[0])
    for name in sorted(_os.listdir(real)):
        stat = _os.stat(real + '/' + name)
        folder = _os.path.isdir(real + '/' + name)
        yield (name, 0x4000 if folder else 0x8000, 0, 0 if folder else stat.st_size)
board_os.ilistdir = _wrap(lambda path='': list(_ilistdir(path)))
def _stat(path):
    real = _real(path)
    stat = _os.stat(real)
    mode = 0x4000 if _os.path.isdir(real) else 0x8000
    return (mode, 0, 0, 0, 0, 0, 0 if mode == 0x4000 else stat.st_size, 0, 0, 0)
board_os.stat = _wrap(_stat)
def _mkdir(path):
    real = _real(path)
    if _os.path.exists(real):
        raise FileExistsError(errno.EEXIST, 'EEXIST')
    _os.mkdir(real)
board_os.mkdir = _wrap(_mkdir)
def _rmdir(path):
    real = _real(path)
    if _os.listdir(real):
        raise PermissionError(errno.EACCES, 'EACCES')
    _os.rmdir(real)
board_os.rmdir = _wrap(_rmdir)
def _remove(path):
    real = _real(path)
    if _os.path.isdir(real):
        raise IsADirectoryError(errno.EISDIR, 'EISDIR')
    _os.remove(real)
board_os.remove = _wrap(_remove)
def _rename(old, new):
    if _os.path.exists(_real(new)):
        raise FileExistsError(errno.EEXIST, 'EEXIST')
    _os.rename(_real(old), _real(new))
board_os.rename = _wrap(_rename)
board_os.statvfs = lambda path: (4096, 4096, 2048, FREE_BLOCKS[0], FREE_BLOCKS[0], 0, 0, 0, 0, 255)
board_os.getcwd = lambda: _cwd[0]
def _chdir(path):
    if not _os.path.isdir(_real(path)):
        raise _oserror(FileNotFoundError(errno.ENOENT, 'ENOENT'))
    _cwd[0] = '/' + _real(path)[len(ROOT):].strip('/')
board_os.chdir = _chdir
board_os.sep = '/'
board_os.uname = lambda: ('fake', 'fake', '1.0', 'v1.0', 'fake')
FREE_BLOCKS = [1500]

def _open(path, mode='r', *args, **kwargs):
    try:
        return builtins.open(_real(path), mode, *args, **kwargs)
    except OSError as exc:
        raise _oserror(exc) from None

SETUP = json.loads(SETUP_JSON)

machine = types.ModuleType('machine')
machine.unique_id = lambda: bytes.fromhex(SETUP.get('id', 'a1b2c3d4e5f6'))
machine.reset = lambda: None
machine.soft_reset = lambda: None

gc = types.ModuleType('gc')
gc.collect = lambda: None
gc.mem_free = lambda: 4_000_000
gc.mem_alloc = lambda: 100_000

micropython = types.ModuleType('micropython')
micropython.const = lambda value: value

class Anything:
    """What the fake lvgl gives for every name: it can be called, read, combined and compared,
    so that a generated app runs on the fake board without drawing anything."""
    def __init__(self, *args, **kwargs): pass
    def __call__(self, *args, **kwargs): return Anything()
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        return Anything()
    def __iter__(self): return iter(())
    def __len__(self): return 0
    def __bool__(self): return True
    def __int__(self): return 0
    def __index__(self): return 0
    def __float__(self): return 0.0
    def __hash__(self): return 0
    def __eq__(self, other): return isinstance(other, Anything)
    def __lt__(self, other): return False
    __gt__ = __le__ = __ge__ = __lt__
    def _same(self, *args): return Anything()
    __or__ = __ror__ = __and__ = __rand__ = __add__ = __radd__ = __sub__ = __rsub__ = _same
    __mul__ = __rmul__ = __floordiv__ = __truediv__ = __mod__ = __neg__ = __invert__ = __lshift__ = __rshift__ = _same
    def __getitem__(self, key): return Anything()
    def __setitem__(self, key, value): pass
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def __mro_entries__(self, bases): return (object,)

lvgl = types.ModuleType('lvgl')
def _lvgl_name(name):
    # what the probe looks for must answer as the firmware: only the fonts it has
    if name.startswith('font_montserrat_') or name.startswith('__'):
        raise AttributeError(name)
    return Anything()
lvgl.__getattr__ = _lvgl_name
for name in ('obj', 'screen_load', 'EVENT', 'timer_handler', 'binfont_create_from_buffer'):
    setattr(lvgl, name, Anything())
lvgl.version_info = lambda: tuple(SETUP['lvgl'])
for size in SETUP['fonts']:
    setattr(lvgl, 'font_montserrat_%d' % size, object())

display_driver = types.ModuleType('display_driver')
display_driver.WIDTH, display_driver.HEIGHT = SETUP['width'], SETUP['height']
display_driver.BUFFERS = 2
display_driver.indev = object() if SETUP.get('touch', True) else None
display_driver.start = lambda *args: None
display_driver.stop = lambda: None

FIRMWARE = {'machine': machine, 'gc': gc, 'micropython': micropython, 'lvgl': lvgl, 'display_driver': display_driver,
            'rgbpanel': types.ModuleType('rgbpanel'), 'gt911': types.ModuleType('gt911'), 'st_ltdc': types.ModuleType('st_ltdc'),
            'binascii': binascii, 'hashlib': hashlib, 'json': json, 'struct': __import__('struct'), 'time': __import__('time'),
            'io': io, 'errno': errno, 'vfs': types.ModuleType('vfs')}

board_sys = types.ModuleType('sys')
board_sys.implementation = types.SimpleNamespace(name='micropython', version=tuple(SETUP['micropython']), _mpy=SETUP['mpy'])
board_sys.version = '3.4.0; MicroPython v%d.%d.%d' % tuple(SETUP['micropython'])
board_sys.platform = 'fake'
board_sys.path = ['', '/lib']
board_sys.argv = []
board_sys.byteorder = 'little'
board_sys.maxsize = 2**31 - 1

def _fresh():
    board_sys.modules = {}
    board_sys.path[:] = ['', '/lib']
    namespace = {'__name__': '__main__', '__builtins__': BOARD_BUILTINS}
    return namespace

def _find(name):
    for folder in board_sys.path:
        base = (folder or _cwd[0]).rstrip('/')
        for candidate in (base + '/' + name + '.py', base + '/' + name + '/__init__.py'):
            if _os.path.isfile(_real(candidate)):
                return candidate
    return None

def _import(name, globals=None, locals=None, fromlist=(), level=0):
    top = name.split('.')[0]
    if top in ('os', 'uos'):
        module = board_os
    elif top == 'sys':
        module = board_sys
    elif top in FIRMWARE:
        module = FIRMWARE[top]
    elif top in board_sys.modules:
        module = board_sys.modules[top]
    else:
        path = _find(top)
        if path is None:
            raise ImportError("no module named '%s'" % top)
        module = types.ModuleType(top)
        module.__file__ = path
        board_sys.modules[top] = module
        code = builtins.open(_real(path)).read()
        module.__dict__['__builtins__'] = BOARD_BUILTINS
        try:
            exec(compile(code, path, 'exec'), module.__dict__)
        except BaseException:
            board_sys.modules.pop(top, None)
            raise
    return module

BOARD_BUILTINS = dict(builtins.__dict__)
BOARD_BUILTINS['open'] = _open
BOARD_BUILTINS['__import__'] = _import

namespace = _fresh()

def _traceback(exc):
    lines = ['Traceback (most recent call last):\r\n']
    for frame in traceback.extract_tb(exc.__traceback__)[1:]:
        lines.append('  File "%s", line %d, in %s\r\n' % (frame.filename, frame.lineno, frame.name))
    name = type(exc).__name__
    if isinstance(exc, OSError):
        name = 'OSError'
        if not getattr(exc, 'mp', False):
            exc = _oserror(exc)
        text = '[Errno %d] %s' % (exc.errno, MP_NAMES.get(exc.errno, 'EIO'))
    else:
        text = str(exc)
    lines.append('%s: %s\r\n' % (name, text) if text else '%s:\r\n' % name)
    return ''.join(lines)

def run(source, single=False):
    out = io.StringIO()
    error = ''
    with contextlib.redirect_stdout(out):
        try:
            # 'single' at the friendly prompt: the value of an expression is printed
            exec(compile(source, '<stdin>', 'single' if single else 'exec'), namespace)
        except SystemExit:
            pass
        except BaseException as exc:
            error = _traceback(exc)
    return json.dumps([out.getvalue().replace('\n', '\r\n'), error])

def soft_reset():
    global namespace
    namespace = _fresh()
    _cwd[0] = '/'

def write(path, data):
    real = _real(path)
    _os.makedirs(_os.path.dirname(real), exist_ok=True)
    with builtins.open(real, 'wb') as f:
        f.write(bytes(data))

def read(path):
    real = _real(path)
    if not _os.path.isfile(real):
        return None
    with builtins.open(real, 'rb') as f:
        return f.read()

def tree():
    found = []
    for folder, _dirs, files in _os.walk(ROOT):
        for name in files:
            found.append((folder + '/' + name)[len(ROOT):])
    return json.dumps(sorted(found))
`;

const RAW_BANNER = 'raw REPL; CTRL-B to exit\r\n';
const FRIENDLY_BANNER =
  'MicroPython v1.29.0 on 2026-01-01; fake board\r\nType "help()" for more information.\r\n';

type Mode = 'shell' | 'friendly' | 'raw' | 'paste';

/** The board at the far end of a port. send() is how its bytes reach the link. */
export class FakeBoard implements Wire {
  /** Everything the IDE wrote, for the tests that look at the bytes. */
  readonly received: number[] = [];
  /** How many soft resets the board has been through. */
  softResets = 0;
  private mode: Mode;
  private line: number[] = [];
  private pasteRemain = 0;
  private pasteAsk: number[] | null = null;
  /** How many commands came in raw-paste mode. */
  pastes = 0;
  private escape: number[] = [];
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly py: PyodideInterface,
    private readonly setup: Required<BoardSetup>,
    public send: (data: Uint8Array) => void,
  ) {
    this.mode = setup.shell ? 'shell' : 'friendly';
  }

  static async start(setup: BoardSetup, send: (data: Uint8Array) => void = () => {}) {
    const full: Required<BoardSetup> = {
      touch: true,
      micropython: [1, 29, 0],
      lvgl: [9, 5, 0],
      mpy: 6 | (2 << 8),
      shell: false,
      window: 128,
      fonts: [12, 14, 16, 20, 24],
      ...setup,
    };
    const py = await startPyodide();
    py.globals.set('SETUP_JSON', JSON.stringify(full));
    py.runPython(BOARD_PY);
    return new FakeBoard(py, full, send);
  }

  /** A file of the board's file system, or null. */
  file(path: string): Uint8Array | null {
    const data = this.py.globals.get('read')(path) as { toJs(): Uint8Array } | undefined;
    return data ? new Uint8Array(data.toJs()) : null;
  }

  putFile(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.py.globals.get('write')(path, bytes);
  }

  files(): string[] {
    return JSON.parse(this.py.globals.get('tree')() as string) as string[];
  }

  setFree(blocks: number): void {
    this.py.globals.get('FREE_BLOCKS').set(0, blocks);
  }

  get state(): Mode {
    return this.mode;
  }

  private out(text: string | Uint8Array): void {
    const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    // Asynchronous, as a real port: the bytes arrive after the write returns.
    setTimeout(() => this.send(data), 0);
  }

  write(data: Uint8Array): void {
    this.received.push(...data);
    // In order, each byte once the ones before have been answered.
    this.pending = this.pending.then(() => {
      for (const byte of data) this.byte(byte);
    });
  }

  drain(): Promise<void> {
    return this.pending;
  }

  private byte(c: number): void {
    switch (this.mode) {
      case 'shell':
        if (c === 0x03) {
          this.out('\r\nCtrl-C again leaves the shell\r\n');
          this.mode = 'friendly';
          this.out('>>> ');
        }
        return;
      case 'friendly':
        return this.friendly(c);
      case 'raw':
        return this.raw(c);
      case 'paste':
        return this.paste(c);
    }
  }

  private friendly(c: number): void {
    if (this.escape.length) {
      this.escape.push(c);
      if (this.escape.length >= 3 || (c >= 0x40 && c <= 0x7e && this.escape.length > 1)) {
        this.escape = [];
      }
      return;
    }
    if (c === 0x1b) {
      this.escape = [c];
    } else if (c === 0x01) {
      this.line = [];
      this.mode = 'raw';
      this.out('\r\n' + RAW_BANNER + '>');
    } else if (c === 0x02) {
      this.line = [];
      this.out('\r\n' + FRIENDLY_BANNER + '>>> ');
    } else if (c === 0x03) {
      this.line = [];
      this.out('\r\n>>> ');
    } else if (c === 0x04) {
      this.line = [];
      this.softReset();
      this.out('MPY: soft reboot\r\n' + FRIENDLY_BANNER + '>>> ');
    } else if (c === 0x0d) {
      const source = new TextDecoder().decode(new Uint8Array(this.line));
      this.line = [];
      this.out('\r\n');
      if (source.trim()) this.execute(source, false);
      this.out('>>> ');
    } else if (c === 0x08 || c === 0x7f) {
      if (this.line.pop() !== undefined) this.out('\b \b');
    } else if (c >= 0x20 || c === 0x09) {
      this.line.push(c);
      this.out(new Uint8Array([c]));
    }
  }

  private raw(c: number): void {
    // pyexec.c: Ctrl-E on an empty line asks for raw-paste, and the next two bytes say how.
    if (this.pasteAsk !== null) {
      this.pasteAsk.push(c);
      if (this.pasteAsk.length < 2) return;
      const [a, b] = this.pasteAsk;
      this.pasteAsk = null;
      if (a !== 0x41 || b !== 0x01) {
        this.out('R\x00');
        return;
      }
      if (!this.setup.window) {
        this.out('R\x00');
        return;
      }
      const w = this.setup.window;
      this.out(new Uint8Array([0x52, 0x01, w & 0xff, w >> 8]));
      this.pasteRemain = w;
      this.pastes += 1;
      this.mode = 'paste';
      return;
    }
    if (c === 0x05 && this.line.length === 0) {
      this.pasteAsk = [];
    } else if (c === 0x01) {
      this.line = [];
      this.out('\r\n' + RAW_BANNER + '>');
    } else if (c === 0x02) {
      this.line = [];
      this.mode = 'friendly';
      this.out('\r\n' + FRIENDLY_BANNER + '>>> ');
    } else if (c === 0x03) {
      this.line = [];
    } else if (c === 0x04) {
      const source = this.line;
      this.line = [];
      this.out('OK');
      if (!source.length) {
        this.out('\r\n');
        this.softReset();
        this.out('MPY: soft reboot\r\n' + RAW_BANNER + '>');
        return;
      }
      this.execute(new TextDecoder().decode(new Uint8Array(source)), true);
      this.out('>');
    } else {
      this.line.push(c);
    }
  }

  private paste(c: number): void {
    if (c === 0x04) {
      const source = new TextDecoder().decode(new Uint8Array(this.line));
      this.line = [];
      this.mode = 'raw';
      this.out('\x04');
      this.execute(source, true);
      this.out('>');
      return;
    }
    if (c === 0x03) {
      this.line = [];
      this.mode = 'raw';
      this.out('\x04');
      return;
    }
    this.line.push(c);
    this.pasteRemain -= 1;
    if (this.pasteRemain === 0) {
      this.pasteRemain = this.setup.window;
      this.out('\x01');
    }
  }

  private execute(source: string, raw: boolean): void {
    const [stdout, stderr] = JSON.parse(this.py.globals.get('run')(source, !raw) as string) as [
      string,
      string,
    ];
    if (raw) this.out(stdout + '\x04' + stderr + '\x04');
    else this.out(stdout + stderr);
  }

  private softReset(): void {
    this.softResets += 1;
    this.py.globals.get('soft_reset')();
  }
}
