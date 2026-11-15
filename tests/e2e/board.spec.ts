// Phase 6: the board over Web Serial. A fake navigator.serial in the page carries the bytes to the
// scripted MicroPython board of the transport tests (tests/py/fake-board.ts), which runs here in
// Node; everything between is the IDE's: the port, the worker, upstream's DeviceSession.
import type { Page } from '@playwright/test';
import { FakeBoard, type BoardSetup } from '../py/fake-board.ts';
import { expect, test } from './fixtures.ts';

declare global {
  interface Window {
    __fakeSerialPush?: (bytes: number[]) => void;
    __fakeSerialWrite?: (bytes: number[]) => Promise<void>;
  }
}

async function start(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

async function menu(page: Page, top: string, ...path: string[]) {
  await page.getByRole('button', { name: top, exact: true }).click();
  for (const item of path) await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** A USB serial port in the page, wired to a FakeBoard here. */
async function plugBoard(page: Page, setup: BoardSetup): Promise<FakeBoard> {
  let delivering = Promise.resolve();
  const board = await FakeBoard.start(setup, (data) => {
    const bytes = Array.from(data);
    delivering = delivering.then(() =>
      page.evaluate((chunk) => window.__fakeSerialPush?.(chunk), bytes),
    );
  });
  await page.exposeFunction('__fakeSerialWrite', (bytes: number[]) => {
    board.write(Uint8Array.from(bytes));
  });
  await page.addInitScript(() => {
    let push: ((bytes: number[]) => void) | null = null;
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      writable: null as WritableStream<Uint8Array> | null,
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() {
        port.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (bytes) => controller.enqueue(Uint8Array.from(bytes));
          },
        });
        port.writable = new WritableStream<Uint8Array>({
          write: (chunk) => window.__fakeSerialWrite?.(Array.from(chunk)),
        });
      },
      async close() {
        port.readable = port.writable = null;
      },
      async setSignals() {},
      addEventListener() {},
      removeEventListener() {},
    };
    window.__fakeSerialPush = (bytes) => push?.(bytes);
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        requestPort: async () => port,
        getPorts: async () => [port],
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });
  return board;
}

const consoleText = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector('lms-app')?.shadowRoot?.querySelector('lms-device-console')?.text ??
      '',
  );

test.describe('board over Web Serial', () => {
  // Any engine with JSPI runs it: the port is the fake one, the rest is the IDE's.

  test('connect, information, restart and disconnect', async ({ page }) => {
    const board = await plugBoard(page, { width: 480, height: 480, shell: true });
    await start(page);
    await menu(page, 'File', 'Open Example', 'weather');
    await expect(page.getByTestId('project-file')).toHaveText('Examples: weather/project.json');
    await menu(page, 'Device', 'Connect');
    await expect(page.getByTestId('device-status')).toHaveText('Connected to USB 303a:1001', {
      timeout: 30_000,
    });
    await expect.poll(() => consoleText(page)).toContain('"compatible": true');
    await menu(page, 'Device', 'Restart Interpreter');
    await expect.poll(() => board.softResets).toBe(1);
    // The console follows the board when the IDE is not using it
    await expect(page.getByRole('button', { name: 'Ctrl-C', exact: true })).toBeEnabled();
    await page.getByTestId('device-terminal').click();
    await page.keyboard.type('6*7');
    await page.keyboard.press('Enter');
    await expect.poll(() => consoleText(page)).toContain('6*7\r\n42\r\n>>> ');
    await menu(page, 'Device', 'Disconnect');
    await expect(page.getByTestId('device-status')).toHaveText('Board not connected');
  });
});

test('Upload Project sends the generated app, compiled, as the desktop does', async ({ page }) => {
  test.setTimeout(120_000);
  const board = await plugBoard(page, { width: 480, height: 480 });
  await start(page);
  await menu(page, 'File', 'Open Example', 'weather');
  await menu(page, 'Device', 'Upload Project');
  // An example is saved into the workspace first, as upload_board saves the project
  const save = page.locator('lms-dialogs dialog[open]');
  await expect(save.getByRole('heading', { name: 'Save Project' })).toBeVisible();
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  // the window of the upload appears when it takes longer than 0.8 s
  await expect(page.getByTestId('upload-progress')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => consoleText(page), { timeout: 60_000 }).toContain('Upload completed');
  await expect(page.getByTestId('upload-progress')).toBeHidden();
  const files = board.files();
  expect(files.some((path) => /^\/lms_apps\/app_[0-9a-f]{12}\/ui\.mpy$/.test(path))).toBe(true);
});

test('without Web Serial the Device menu says so, and its board items are off', async ({
  page,
}) => {
  // as Safari, which has no navigator.serial
  await page.addInitScript(() => {
    delete (Navigator.prototype as { serial?: unknown }).serial;
  });
  await start(page);
  await menu(page, 'File', 'Open Example', 'weather');
  await page.getByRole('button', { name: 'Device', exact: true }).click();
  await expect(
    page.getByRole('menuitem', {
      name: 'This browser has no Web Serial: the board works in Chrome or Edge',
    }),
  ).toBeDisabled();
  for (const name of ['Change Port…', 'Connect', 'Upload Project', 'Upload and Run']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeDisabled();
  }
});
