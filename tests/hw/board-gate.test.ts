// Phase 6 gate on a real board, without the browser's port: the IDE's whole board stack
// (upstream's DeviceSession in Pyodide, mpremote in-process, py/serial/, SerialLink) on a serial
// port of this PC. Run only with the owner present and agreeing:
//
//   LMS_BOARD_PORT=/dev/ttyUSB0 LMS_BOARD_PROFILE=esp32_4848s040_480 \
//     npx vitest run -c vitest.py.config.ts tests/hw/
//
// The port is reached through tests/hw/serial-bridge.py (pyserial; LMS_BOARD_PYTHON names the
// Python, python3 by default), which sets DTR and RTS as the page does: RTS low for the STM32's
// UART adapter, as upstream's UartTransport.
//
// What it does to the board: Ctrl-C (interrupts what runs), writes the shell example into the
// folder lms-gate-test of the board's program folder (_board_program_root: /flash on the STM32,
// / else), runs it, edits its README.md, restarts the interpreter, then removes the folder. It
// stops before writing if lms-gate-test is already there: nothing of the owner's is replaced or
// removed. main.py and boot.py are not touched.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
/** A folder of this test's own: never one the board already has (the gate wrote into /flash/shell
 * of the STM32 once, which held the owner's copy of the shell, and removed it). */
const FOLDER = 'lms-gate-test';

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
  let bridge: ChildProcess | null = null;
  /** Set once the listing showed no FOLDER: nothing is written or removed before. */
  let folderFree = false;
  const requireFreeFolder = () => {
    if (!folderFree)
      throw new Error(`${FOLDER} was not seen free on the board: nothing is written`);
  };
  /** The board's program folder, '' for the root. */
  let root = '';
  let call: <T>(method: string, ...args: unknown[]) => Promise<Reply<T>>;
  let profile: { adapter: string; config?: { appRoot?: string } };
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
    profile = JSON.parse(
      py.runPython(
        `import json\nfrom lvgl_mpy_studio.core.boards import ProfileStore, portable_profile\njson.dumps(portable_profile(ProfileStore().get(${JSON.stringify(PROFILE)})))`,
      ) as string,
    ) as { adapter: string; config?: { appRoot?: string } };
    // _board_program_root
    root = String(profile.config?.appRoot ?? '').startsWith('/flash') ? '/flash' : '';
    const rts = profile.adapter === 'stm32h7_uart' ? '0' : '1';
    bridge = spawn(
      process.env.LMS_BOARD_PYTHON ?? 'python3',
      [join(ROOT, 'tests/hw/serial-bridge.py'), DEVICE, '1', rts],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const wire = bridge;
    link = links.open(
      { port: PORT },
      {
        write: (data) => void wire.stdin?.write(data),
        drain: async () => {},
      },
    );
    wire.stdout?.on('data', (chunk: Buffer) => link.receive(new Uint8Array(chunk)));
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
  }, 120_000);

  afterAll(() => {
    console.log(log.join('\n'));
    bridge?.stdin?.end();
    bridge?.kill();
  });

  it('connects and reads the firmware', async () => {
    const reply = await call<Record<string, unknown>>('connect', PORT, profile);
    expect(reply.error?.output ?? reply.error?.traceback ?? '').toBe('');
    console.log(JSON.stringify(reply.result, null, 2));
    expect(reply.result.implementation).toBe('micropython');
  }, 120_000);

  it('lists the files of the board', async () => {
    const reply = await call<{ name: string; dir: boolean }[]>('list_dir', root || '/');
    expect(reply.ok).toBe(true);
    // the scenario writes and removes FOLDER: stop here if the board already has one
    expect(reply.result.map((e) => e.name)).not.toContain(FOLDER);
    folderFree = true;
    console.log(reply.result.map((e) => e.name + (e.dir ? '/' : '')).join('  '));
  }, 60_000);

  it('uploads the shell example and runs it', async () => {
    requireFreeFolder();
    const folder = join(ROOT, 'upstream/examples/shell');
    const names: string[] = [];
    for (const path of files(folder)) {
      const name = `${FOLDER}/${relative(folder, path).split(sep).join('/')}`;
      py.FS.mkdirTree(`/board-upload/${name.slice(0, name.lastIndexOf('/'))}`);
      py.FS.writeFile(`/board-upload/${name}`, readFileSync(path));
      names.push(name);
    }
    const started = Date.now();
    const reply = await call<{ files: string[] }>('upload_files', names, root || '/');
    expect(reply.error?.output ?? reply.error?.traceback ?? '').toBe('');
    console.log(
      `${reply.result.files.length} files in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
    // as Run File on Board: the normal prompt, then the line typed at it, through the console
    await call('leave_raw');
    const line = (await call<string>('run_line', `${root}/${FOLDER}/shell.py`)).result;
    link.clear();
    const from = consoleText.length;
    type(`\x03${line}\r`);
    await waitFor('$ ', from, 30_000);
  }, 600_000);

  it('Ctrl-C five times in sleep 5: the prompt each time, no traceback', async () => {
    requireFreeFolder();
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
    requireFreeFolder();
    const read = await call<{ data: string }>('read_file', `${root}/${FOLDER}/README.md`);
    expect(read.ok).toBe(true);
    const text = Buffer.from(read.result.data, 'base64').toString('utf8');
    const edited = `${text}\nEdited by the web IDE's board test.\n`;
    expect(
      (
        await call(
          'write_file',
          `${root}/${FOLDER}/README.md`,
          Buffer.from(edited).toString('base64'),
        )
      ).ok,
    ).toBe(true);
    const again = await call<{ data: string }>('read_file', `${root}/${FOLDER}/README.md`);
    expect(Buffer.from(again.result.data, 'base64').toString('utf8')).toBe(edited);
  }, 120_000);

  it('removes the folder it uploaded', async () => {
    requireFreeFolder();
    // the shell left the folder as the current one: on FAT (the STM32's /flash) it cannot be
    // removed then (EACCES), so the interpreter is restarted first (upstream request 11)
    expect((await call('restart')).ok).toBe(true);
    expect((await call('remove_path', `${root}/${FOLDER}`)).ok).toBe(true);
    const listing = await call<{ name: string }[]>('list_dir', root || '/');
    expect(listing.result.map((e) => e.name)).not.toContain(FOLDER);
    expect((await call('disconnect')).ok).toBe(true);
  }, 120_000);
});
