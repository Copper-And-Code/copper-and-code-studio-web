// The board transport: upstream's DeviceSession in Pyodide, with mpremote 1.29.0 in-process
// over the serial link (py/serial/), against a scripted MicroPython REPL (fake-board.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { SerialLinks } from '../../src/board/link.ts';
import { compileOnce, type MpyCrossFactory } from '../../src/mpy/compile.ts';
import { installUpstream } from '../../src/py/boot.ts';
import { FakeBoard, type BoardSetup } from './fake-board.ts';
import { copyIn, ROOT, startPyodide } from './pyodide-node.mjs';

interface Reply<T> {
  ok: boolean;
  result: T;
  error?: { code?: string; message: string; text?: string; output?: string; traceback?: string };
}

const PORT = 'webserial:1';
const progress: [number, number, string, number][] = [];

async function upstream(): Promise<{ py: PyodideInterface; links: SerialLinks }> {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
    file: string;
  };
  const py = await startPyodide();
  const factory = (
    (await import(pathToFileURL(join(ROOT, 'public/mpy-cross/mpy-cross.mjs')).href)) as {
      default: MpyCrossFactory;
    }
  ).default;
  const wasm = await WebAssembly.compile(
    readFileSync(join(ROOT, 'public/mpy-cross/mpy-cross.wasm')),
  );
  const links = new SerialLinks({
    compile: (name, source, args) => compileOnce(factory, wasm, name, source, args),
    progress: (...report) => progress.push(report),
  });
  py.registerJsModule('lms_serial', links.module());
  installUpstream(py, new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))));
  return { py, links };
}

describe('board transport', () => {
  let py: PyodideInterface;
  let links: SerialLinks;
  let call: <T>(method: string, ...args: unknown[]) => Promise<Reply<T>>;
  let profiles: Record<string, unknown>;

  async function plug(setup: BoardSetup): Promise<FakeBoard> {
    // as the page does before another connection: DeviceSession forgets the STM32's UART only there
    if (call) await call('disconnect');
    const board = await FakeBoard.start(setup);
    const link = links.open({ port: PORT }, board);
    board.send = (data) => link.receive(data);
    return board;
  }

  beforeAll(async () => {
    ({ py, links } = await upstream());
    const lmsBoard = py.pyimport('lms_board');
    const board = lmsBoard.call as { callPromising(...args: unknown[]): Promise<string> };
    call = async <T>(method: string, ...args: unknown[]) =>
      JSON.parse(await board.callPromising(method, JSON.stringify(args))) as Reply<T>;
    profiles = JSON.parse(
      py.runPython(`
import json
from copper_and_code_studio.core.boards import ProfileStore, portable_profile
json.dumps({p["id"]: portable_profile(p) for p in ProfileStore().profiles()})
`) as string,
    ) as Record<string, unknown>;
  }, 120_000);

  it('connects through a firmware shell and reads the board', async () => {
    const board = await plug({ width: 480, height: 480, shell: true });
    const reply = await call<Record<string, unknown>>('connect', PORT, profiles.esp32_4848s040_480);
    expect(reply.error?.traceback ?? '').toBe('');
    expect(reply.result).toMatchObject({
      implementation: 'micropython',
      compatible: true,
      width: 480,
      height: 480,
      deviceId: 'a1b2c3d4e5f6',
      missingModules: [],
    });
    expect(board.softResets).toBe(0);
    expect(board.pastes).toBeGreaterThan(0); // mpremote's raw-paste, with its windows
    expect((await call('state')).result).toMatchObject({ port: PORT, state: 'ready' });
  });

  it('says what does not match the profile', async () => {
    await plug({ width: 320, height: 240, lvgl: [9, 2, 0] });
    const reply = await call<Record<string, unknown>>('connect', PORT, profiles.esp32_4848s040_480);
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({ compatible: false, sizeCompatible: false });
    expect(reply.result.missingRequirements).toEqual(['lvgl', 'resolution']);
  });

  it('lists, writes, reads, renames and removes files', async () => {
    const board = await plug({ width: 480, height: 480 });
    board.putFile('/flash/shell.py', 'print("shell")\n');
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    expect((await call('list_dir', '/')).result).toEqual([{ name: 'flash', dir: true, size: 0 }]);
    const data = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff);
    const written = await call(
      'write_file',
      '/flash/data.bin',
      Buffer.from(data).toString('base64'),
    );
    expect(written.error?.traceback ?? '').toBe('');
    expect(board.file('/flash/data.bin')).toEqual(data);
    const read = await call<{ data: string }>('read_file', '/flash/data.bin');
    expect(read.error?.traceback ?? '').toBe('');
    expect(new Uint8Array(Buffer.from(read.result.data, 'base64'))).toEqual(data);
    expect((await call('make_dir', '/flash/app')).ok).toBe(true);
    expect((await call('rename_path', '/flash/shell.py', '/flash/app/shell.py')).ok).toBe(true);
    expect((await call('list_dir', '/flash')).result).toEqual([
      { name: 'app', dir: true, size: 0 },
      { name: 'data.bin', dir: false, size: 3000 },
    ]);
    expect((await call('remove_path', '/flash/app')).ok).toBe(true);
    expect(board.files()).toEqual(['/flash/data.bin']);
    const refused = await call('remove_path', '/flash');
    expect(refused.error?.code).toBe('device.command');
  });

  it('falls back to the plain raw REPL on old firmware', async () => {
    const board = await plug({ width: 480, height: 480, window: 0 });
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    expect(board.pastes).toBe(0);
  });

  it('keeps answering the page while the board is busy', async () => {
    await plug({ width: 480, height: 480 });
    const bridge = py.pyimport('lms_bridge').call as (method: string, json: string) => string;
    const connecting = call('connect', PORT, profiles.esp32_4848s040_480);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // a call of the designer meanwhile, while Python waits for the board
    expect(JSON.parse(bridge('info', '[]')).ok).toBe(true);
    expect((await connecting).ok).toBe(true);
  });

  it('reports an error of the board as upstream does', async () => {
    await plug({ width: 480, height: 480 });
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    const reply = await call('list_dir', '/missing');
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('device.command');
    expect(reply.error?.output).toContain('ENOENT');
  });

  it('talks to the STM32 over its UART protocol', async () => {
    const board = await plug({ width: 1024, height: 600 });
    const reply = await call<Record<string, unknown>>(
      'connect',
      PORT,
      profiles.stm32h7_core_v1_3_1024x600,
    );
    expect(reply.error?.traceback ?? '').toBe('');
    expect(reply.result).toMatchObject({ compatible: true, width: 1024 });
    const data = new Uint8Array(2000).map((_, i) => i & 0xff);
    expect(
      (await call('write_file', '/flash/x.bin', Buffer.from(data).toString('base64'))).ok,
    ).toBe(true);
    expect(board.file('/flash/x.bin')).toEqual(data);
    expect(board.state).toBe('raw');
    await call('leave_raw');
    await board.drain();
    expect(board.state).toBe('friendly');
  }, 60_000);

  it('uploads the open project as upstream does', async () => {
    const board = await plug({ width: 480, height: 480 });
    copyIn(py, join(ROOT, 'upstream/examples/weather'), '/ws/weather');
    const bridge = py.pyimport('lms_bridge').call as (method: string, json: string) => string;
    const opened = JSON.parse(bridge('doc_open', JSON.stringify(['/ws/weather/project.json']))) as {
      ok: boolean;
    };
    expect(opened.ok).toBe(true);
    expect((await call('connect', PORT)).ok).toBe(true);
    progress.length = 0;
    type Uploaded = { appPath: string; files: string[]; reused: string[]; warnings: string[] };
    const reply = await call<Uploaded>('upload');
    expect(reply.error?.traceback ?? '').toBe('');
    expect(reply.result.reused).toEqual([]); // nothing on the board yet
    const app = reply.result.appPath;
    expect(app).toMatch(/^\/lms_apps\/app_[0-9a-f]{12}$/);
    expect(reply.result.files).toEqual(expect.arrayContaining(['ui.mpy', 'app_main.py']));
    const onBoard = board.files().filter((path) => path.startsWith(app + '/'));
    expect(onBoard.map((path) => path.slice(app.length + 1)).sort()).toEqual(
      [...reply.result.files].sort(),
    );
    expect(board.file(`${app}/ui.mpy`)?.[0]).toBe(0x4d);
    // only the reset before the upload: since upstream 0.7.2 _put runs `mpremote … resume fs cp`,
    // so copying the files does not reset the board again, as on the desktop
    expect(board.softResets).toBe(1);
    const last = progress.at(-1);
    expect(last?.[0]).toBe(last?.[1]);
    // A second upload keeps the first as .previous, and since upstream 0.9.0 the board copies from
    // it the files that are still the same (size and sha256 checked by the board): they do not travel
    const second = await call<Uploaded>('upload');
    expect(second.ok).toBe(true);
    expect(board.files().some((path) => path.startsWith(app + '.previous/'))).toBe(true);
    expect(second.result.reused).toContain('ui.mpy');
    expect(second.result.files).toEqual(expect.arrayContaining(second.result.reused));
  }, 120_000);

  it('copies files of the PC, compiled, and asks what upstream asks', async () => {
    const board = await plug({ width: 480, height: 480 });
    board.putFile('/flash/util.py', 'x = 1\n');
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    py.FS.mkdirTree('/board-upload/util');
    py.FS.writeFile('/board-upload/util/__init__.py', 'y = 2\n');
    py.FS.writeFile('/board-upload/main.py', 'import util\n');
    const names = ['util/__init__.py', 'main.py'];
    expect((await call('protected_targets', names, '/')).result).toEqual(['/main.py']);
    expect((await call('protected_targets', names, '/flash')).result).toEqual(['/flash/main.py']);
    const listing = (await call('list_dir', '/flash')).result;
    expect((await call('shadowed_modules', names, listing)).result).toEqual(['util']);
    const reply = await call<{ files: string[]; warnings: string[] }>(
      'upload_files',
      names,
      '/flash',
      true,
    );
    expect(reply.error?.traceback ?? '').toBe('');
    expect(reply.result.files).toEqual(['/flash/util/__init__.mpy', '/flash/main.py']);
    expect(board.file('/flash/util/__init__.mpy')?.[0]).toBe(0x4d);
    expect(new TextDecoder().decode(board.file('/flash/main.py') ?? new Uint8Array())).toBe(
      'import util\n',
    );
    expect((await call('run_line', '/flash/shell.py')).result).toBe(
      "import os; os.chdir('/flash'); exec(open('shell.py').read(), {'__name__': '__main__', '__file__': '/flash/shell.py'})",
    );
  }, 60_000);

  it('cancels an upload after another call was answered meanwhile', async () => {
    await plug({ width: 480, height: 480 });
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    const names = [1, 2, 3, 4, 5, 6].map((n) => `data${n}.txt`);
    py.FS.mkdirTree('/board-upload');
    for (const name of names) py.FS.writeFile(`/board-upload/${name}`, 'x'.repeat(4000));
    const upload = call<{ files: string[] }>('upload_files', names, '/flash', false);
    // The upload waits for the board. The page asks something else meanwhile, outside its queue
    // (the tracebacks of what the board printed, from a timer): that call took the upload's
    // cancel away with its own.
    expect((await call('destinations')).ok).toBe(true);
    (py.pyimport('lms_board').cancel as () => string)();
    const reply = await upload;
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('device.cancelled');
  }, 60_000);

  it('types a file of the board as upstream does, with a space in its path too', async () => {
    expect((await call('run_line', '/flash/my game/main.py')).result).toBe(
      "import os; os.chdir('/flash/my game'); exec(open('main.py').read(), {'__name__': '__main__', '__file__': '/flash/my game/main.py'})",
    );
    expect((await call('run_line', 'q = open("a").py')).result).toBe('q = open("a").py');
    // upstream's module imports Qt, so py/lms_board.py has a copy: the same function, to the letter
    const source = (file: string) =>
      /^def run_line\(text\):\n(?:(?: {4}.*)?\n)*/m.exec(
        readFileSync(join(ROOT, file), 'utf8'),
      )?.[0];
    expect(source('py/lms_board.py')).toContain('return text\n');
    expect(source('py/lms_board.py')).toBe(
      source('upstream/copper_and_code_studio/ui/device_files.py'),
    );
  });

  it('runs the app, updates it live, and stops it', async () => {
    // without bytecode: the fake board runs Python source only
    const fonts = [
      8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48,
    ];
    const board = await plug({ width: 480, height: 480, mpy: null, fonts });
    expect((await call('connect', PORT)).ok).toBe(true); // weather, opened by the upload test
    const run = await call<{
      active: boolean;
      uploadKey: string;
      designKey: string;
      output: string;
      sourcemap: { entries: { handler: string; line: number }[] };
    }>('upload', true);
    expect(run.error?.output ?? run.error?.traceback ?? '').toBe('');
    expect(run.result.active).toBe(true);
    // a traceback of the board, in a handler: the row names the handler, as _device_output does
    const entry = run.result.sourcemap.entries[0];
    expect(entry).toBeDefined();
    const trace = `Traceback (most recent call last):\r\n  File "${'/lms_apps/app/app_events.py'}", line ${entry?.line ?? 0}, in ${entry?.handler}\r\nZeroDivisionError: divide by zero\r\n`;
    const rows = await call<{ handler?: string; origin: boolean }[]>(
      'trace_errors',
      trace,
      run.result.sourcemap,
    );
    expect(rows.result).toMatchObject([{ handler: entry?.handler, origin: true }]);
    // the check the page makes first: the keys compared, nothing sent to the board
    for (const [upload, design, status] of [
      [run.result.uploadKey, run.result.designKey, 'same'],
      [run.result.uploadKey, 'older', 'changed'],
      ['another code', run.result.designKey, 'stale'],
    ]) {
      expect((await call('live_check', upload, design)).result).toEqual({ status });
    }
    const same = await call('live_send', run.result.uploadKey, run.result.designKey);
    expect(same.result).toEqual({ status: 'same' });
    const changed = await call<{ status: string }>('live_send', run.result.uploadKey, 'older');
    expect(changed.error?.output ?? changed.error?.traceback ?? '').toBe('');
    expect(changed.result.status).toBe('sent');
    expect((await call('live_send', 'another code', run.result.designKey)).result).toEqual({
      status: 'stale',
    });
    const stopped = await call<string>('stop');
    expect(stopped.result).toContain('LMS_STOPPED');
    expect(board.softResets).toBeGreaterThan(0);
  }, 120_000);

  it('installs the autostart, keeps the main.py it replaces, and puts it back', async () => {
    const board = await plug({ width: 480, height: 480 });
    board.putFile('/main.py', 'print("mine")\n');
    expect((await call('connect', PORT)).ok).toBe(true);
    expect((await call('upload')).ok).toBe(true);
    const installed = await call<{ backup: string; appPath: string }>('install_autostart');
    expect(installed.error?.output ?? installed.error?.traceback ?? '').toBe('');
    const launcher = new TextDecoder().decode(board.file('/main.py') ?? new Uint8Array());
    expect(launcher.startsWith('# LMS_AUTOSTART_V2\n')).toBe(true);
    expect(launcher).toContain(`sys.path.insert(0, '${installed.result.appPath}')`);
    // the backup is on this side, in config_dir, under the board's hardware id
    expect(installed.result.backup).toContain('/autostart-backups/a1b2c3d4e5f6/');
    expect(new TextDecoder().decode(py.FS.readFile(`${installed.result.backup}/main.py`))).toBe(
      'print("mine")\n',
    );
    const removed = await call('remove_autostart');
    expect(removed.error?.output ?? removed.error?.traceback ?? '').toBe('');
    expect(new TextDecoder().decode(board.file('/main.py') ?? new Uint8Array())).toBe(
      'print("mine")\n',
    );
    // a main.py that is not the launcher is never touched
    expect((await call('remove_autostart')).error?.code).toBe('device.autostart.manifest');
  }, 120_000);

  it('gives up when the port goes away', async () => {
    await plug({ width: 480, height: 480 });
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    links.close(PORT);
    const reply = await call('list_dir', '/');
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('device.absent');
  });

  it('the folder of a program on the board is known without a board profile too', async () => {
    const bridge = py.pyimport('lms_bridge').call as (method: string, json: string) => string;
    const root = async () => (await call<string>('program_root')).result;
    // _board_program_root: the flash of the STM32 boards
    bridge('doc_new', JSON.stringify([null, 'stm32h7_core_v1_3_1024x600']));
    expect(await root()).toBe('/flash');
    bridge('doc_new', JSON.stringify([null, 'esp32_4848s040_480']));
    expect(await root()).toBe('/');
    // A project without a board (the frog example): upstream answers "/" and Run on the Board
    // goes on to say that a board profile is needed; an error here stopped it with no word.
    py.runPython('import lms_bridge\nlms_bridge._doc().project.board = None');
    expect(await root()).toBe('/');
  });
});
