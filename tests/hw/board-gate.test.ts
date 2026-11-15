// Phase 6 gate on a real board, without the browser's port: the IDE's whole board stack
// (upstream's DeviceSession in Pyodide, mpremote in-process, py/serial/, SerialLink) on a serial
// port of this PC. Run only with the owner present and agreeing:
//
//   LMS_BOARD_PORT=/dev/ttyUSB0 LMS_BOARD_PROFILE=esp32_4848s040_480 \
//     npx vitest run -c vitest.py.config.ts tests/hw/
//
// What it does to the board: Ctrl-C (interrupts what runs), writes the folder /shell (the shell
// example), runs it, edits /shell/README.md, then removes /shell. main.py and boot.py are not
// touched.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  createReadStream,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PyodideInterface } from 'pyodide';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SerialLink, SerialLinks } from '../../src/board/link.ts';
import { compileOnce, type MpyCrossFactory } from '../../src/mpy/compile.ts';
import { installUpstream } from '../../src/py/boot.ts';
import { ROOT, startPyodide } from '../py/pyodide-node.mjs';

const DEVICE = process.env.LMS_BOARD_PORT ?? '';
const PROFILE = process.env.LMS_BOARD_PROFILE ?? 'esp32_4848s040_480';
const PORT = 'webserial:hw';

interface Reply<T> {
  ok: boolean;
  result: T;
  error?: { code?: string; message: string; output?: string; traceback?: string };
}

function files(folder: string, found: string[] = []): string[] {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) files(path, found);
    else found.push(path);
  }
  return found;
}

describe.skipIf(!DEVICE)(`the board on ${DEVICE}`, () => {
  let py: PyodideInterface;
  let link: SerialLink;
  let fd = -1;
  let call: <T>(method: string, ...args: unknown[]) => Promise<Reply<T>>;
  let profile: unknown;
  const log: string[] = [];

  /** What the console received since `from`, as text. */
  let consoleText = '';
  const takeConsole = () => {
    const data = link.take(link.available());
    consoleText += new TextDecoder().decode(data);
    return consoleText;
  };
  const type = (text: string) => link.write(new TextEncoder().encode(text));
  async function waitFor(part: string, from: number, ms = 20_000): Promise<string> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (takeConsole().slice(from).includes(part)) return consoleText.slice(from);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `no ${JSON.stringify(part)} in ${JSON.stringify(consoleText.slice(from).slice(-400))}`,
    );
  }

  beforeAll(async () => {
    // raw 115200; -hupcl: closing the port does not drop DTR, which could reset the board
    execFileSync('stty', ['-F', DEVICE, '115200', 'raw', '-echo', '-hupcl']);
    fd = openSync(DEVICE, constants.O_RDWR | constants.O_NOCTTY);
    py = await startPyodide();
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
      progress: () => {},
    });
    py.registerJsModule('lms_serial', links.module());
    const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
      file: string;
    };
    installUpstream(py, new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))));
    link = links.open(
      { port: PORT },
      {
        write: (data) => void writeSync(fd, data),
        drain: async () => {},
      },
    );
    const stream = createReadStream('', { fd, autoClose: false, highWaterMark: 4096 });
    stream.on('data', (chunk) => link.receive(new Uint8Array(chunk as Buffer)));
    stream.on('error', () => {});
    const board = py.pyimport('lms_board').call as {
      callPromising(...args: unknown[]): Promise<string>;
    };
    call = async <T>(method: string, ...args: unknown[]) => {
      const reply = JSON.parse(await board.callPromising(method, JSON.stringify(args))) as Reply<T>;
      log.push(
        `${method}: ${reply.ok ? 'ok' : `${reply.error?.code} ${reply.error?.output ?? ''}`}`,
      );
      return reply;
    };
    profile = JSON.parse(
      py.runPython(
        `import json\nfrom lvgl_mpy_studio.core.boards import ProfileStore, portable_profile\njson.dumps(portable_profile(ProfileStore().get(${JSON.stringify(PROFILE)})))`,
      ) as string,
    );
  }, 120_000);

  afterAll(() => {
    console.log(log.join('\n'));
    if (fd >= 0) closeSync(fd);
  });

  it('connects and reads the firmware', async () => {
    const reply = await call<Record<string, unknown>>('connect', PORT, profile);
    expect(reply.error?.output ?? reply.error?.traceback ?? '').toBe('');
    console.log(JSON.stringify(reply.result, null, 2));
    expect(reply.result.implementation).toBe('micropython');
  }, 120_000);

  it('lists the files of the board', async () => {
    const reply = await call<{ name: string; dir: boolean }[]>('list_dir', '/');
    expect(reply.ok).toBe(true);
    console.log(reply.result.map((e) => e.name + (e.dir ? '/' : '')).join('  '));
  }, 60_000);

  it('uploads the shell example and runs it', async () => {
    const folder = join(ROOT, 'upstream/examples/shell');
    const names: string[] = [];
    for (const path of files(folder)) {
      const name = `shell/${relative(folder, path).split(sep).join('/')}`;
      py.FS.mkdirTree(`/board-upload/${name.slice(0, name.lastIndexOf('/'))}`);
      py.FS.writeFile(`/board-upload/${name}`, readFileSync(path));
      names.push(name);
    }
    const started = Date.now();
    const reply = await call<{ files: string[] }>('upload_files', names, '/');
    expect(reply.error?.output ?? reply.error?.traceback ?? '').toBe('');
    console.log(
      `${reply.result.files.length} files in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
    // as Run File on Board: the normal prompt, then the line typed at it, through the console
    await call('leave_raw');
    const line = (await call<string>('run_line', '/shell/shell.py')).result;
    link.clear();
    const from = consoleText.length;
    type(`\x03${line}\r`);
    await waitFor('$ ', from, 30_000);
  }, 600_000);

  it('Ctrl-C five times in sleep 5: the prompt each time, no traceback', async () => {
    for (let i = 0; i < 5; i++) {
      type('sleep 5\r');
      // the line editor draws the prompt again at every key: the command starts after Enter
      await waitFor(
        'sleep 5\r\n',
        consoleText.length - 200 > 0 ? consoleText.length - 200 : 0,
        4_000,
      );
      const from = consoleText.length;
      await new Promise((resolve) => setTimeout(resolve, 800));
      const asked = Date.now();
      type('\x03');
      const stopped = await waitFor('^C', from, 4_000);
      const after = from + stopped.indexOf('^C');
      const text = await waitFor('$ ', after, 4_000);
      console.log(`Ctrl-C ${i + 1}: prompt after ${Date.now() - asked} ms`);
      expect(text).not.toContain('Traceback');
    }
  }, 120_000);

  it('Stop gives the prompt of MicroPython back', async () => {
    const reply = await call<string>('stop');
    expect(reply.error?.output ?? reply.error?.traceback ?? '').toBe('');
    expect(reply.result).toContain('LVGL_MPY_STUDIO_STOPPED');
  }, 120_000);

  it('edits a file of the board and saves it', async () => {
    const read = await call<{ data: string }>('read_file', '/shell/README.md');
    expect(read.ok).toBe(true);
    const text = Buffer.from(read.result.data, 'base64').toString('utf8');
    const edited = `${text}\nEdited by the web IDE's board test.\n`;
    expect(
      (await call('write_file', '/shell/README.md', Buffer.from(edited).toString('base64'))).ok,
    ).toBe(true);
    const again = await call<{ data: string }>('read_file', '/shell/README.md');
    expect(Buffer.from(again.result.data, 'base64').toString('utf8')).toBe(edited);
  }, 120_000);

  it('removes the folder it uploaded', async () => {
    expect((await call('remove_path', '/shell')).ok).toBe(true);
    const listing = await call<{ name: string }[]>('list_dir', '/');
    expect(listing.result.map((e) => e.name)).not.toContain('shell');
    expect((await call('disconnect')).ok).toBe(true);
  }, 120_000);
});
