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
from lvgl_mpy_studio.core.boards import ProfileStore, portable_profile
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
    const reply = await call<{ appPath: string; files: string[]; warnings: string[] }>('upload');
    expect(reply.error?.traceback ?? '').toBe('');
    const app = reply.result.appPath;
    expect(app).toMatch(/^\/lms_apps\/app_[0-9a-f]{12}$/);
    expect(reply.result.files).toEqual(expect.arrayContaining(['ui.mpy', 'app_main.py']));
    const onBoard = board.files().filter((path) => path.startsWith(app + '/'));
    expect(onBoard.map((path) => path.slice(app.length + 1)).sort()).toEqual(
      [...reply.result.files].sort(),
    );
    expect(board.file(`${app}/ui.mpy`)?.[0]).toBe(0x4d);
    expect(board.softResets).toBe(1);
    const last = progress.at(-1);
    expect(last?.[0]).toBe(last?.[1]);
    // A second upload keeps the first as .previous
    expect((await call('upload')).ok).toBe(true);
    expect(board.files().some((path) => path.startsWith(app + '.previous/'))).toBe(true);
  }, 120_000);

  it('gives up when the port goes away', async () => {
    await plug({ width: 480, height: 480 });
    expect((await call('connect', PORT, profiles.esp32_4848s040_480)).ok).toBe(true);
    links.close(PORT);
    const reply = await call('list_dir', '/');
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('device.absent');
  });
});
