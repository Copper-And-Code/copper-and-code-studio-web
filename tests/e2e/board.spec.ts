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

const ESP32 = 'ESP32-4848S040 (480×480)';

/**
 * Opens weather and makes its board the run target. Upstream's examples are run in the
 * simulator from its next tag on; the board items of the Device menu need a board target.
 */
async function openOnBoard(page: Page) {
  await menu(page, 'File', 'Open Example', 'weather');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: weather/project.json');
  await page.getByRole('button', { name: /^Run on: / }).click();
  const item = page.getByRole('menuitemcheckbox', {
    name: new RegExp(`^${ESP32.replace(/[()]/g, '\\$&')}`),
  });
  if ((await item.getAttribute('aria-checked')) === 'true') await page.keyboard.press('Escape');
  else await item.click();
  await expect(page.getByRole('button', { name: `Run on: ${ESP32} · no port` })).toBeVisible();
}

/** A USB serial port in the page, wired to a FakeBoard here. */
async function plugBoard(page: Page, setup: BoardSetup): Promise<FakeBoard> {
  let delivering = Promise.resolve();
  const board = await FakeBoard.start(setup, (data) => {
    const bytes = Array.from(data);
    // after the end of a test the page is gone: what the board still says goes nowhere
    delivering = delivering
      .then(() => page.evaluate((chunk) => window.__fakeSerialPush?.(chunk), bytes))
      .catch(() => {});
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
    await openOnBoard(page);
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
  await openOnBoard(page);
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

  // Install Autostart…: the launcher on the board, the transaction kept in the browser's storage
  await menu(page, 'Device', 'Install Autostart…');
  await save.getByRole('button', { name: 'Yes' }).click();
  await expect(page.locator('footer')).toContainText('Autostart installed', { timeout: 60_000 });
  expect(new TextDecoder().decode(board.file('/main.py') ?? new Uint8Array())).toContain(
    '# LMS_AUTOSTART_V2',
  );
  const kept = await page.evaluate(async () => {
    const store = window.lmsStudio.studio?.config?.store;
    const found: string[] = [];
    const walk = async (folder: string) => {
      for (const entry of (await store?.list(folder)) ?? []) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.kind === 'folder') await walk(path);
        else found.push(path);
      }
    };
    await walk('');
    return found;
  });
  expect(kept.some((path) => /autostart-backups\/a1b2c3d4e5f6\/current\.json$/.test(path))).toBe(
    true,
  );
});

test('the run target: the simulator, the board of the profile, one undo step, F5 to the board', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const board = await plugBoard(page, { width: 480, height: 480 });
  await start(page);
  await openOnBoard(page);
  const onBoard = page.getByRole('button', { name: `Run on: ${ESP32} · no port` });
  await onBoard.click();
  await page.getByRole('menuitemcheckbox', { name: 'Simulator', exact: true }).click();
  const onSimulator = page.getByRole('button', { name: 'Run on: Simulator', exact: true });
  await expect(onSimulator).toBeVisible();
  await page.getByRole('button', { name: 'Device', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload Project', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await menu(page, 'Edit', 'Undo');
  await expect(onBoard).toBeVisible();
  // F5 on a board target: Upload and Run, after saving the example into the workspace
  await page.keyboard.press('F5');
  const save = page.locator('lms-dialogs dialog[open]');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => board.files().some((path) => path.endsWith('/ui.mpy')), { timeout: 60_000 })
    .toBe(true);
  await expect(
    page.getByRole('button', { name: `Run on: ${ESP32} · USB 303a:1001` }),
  ).toBeVisible();
});

test('the board in the Files panel: list, edit a file and save it, rename, delete', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const board = await plugBoard(page, { width: 480, height: 480 });
  board.putFile('/flash/shell.py', 'print("shell")\n');
  await start(page);
  await openOnBoard(page);
  await expect(page.getByTestId('board-files-folder')).toHaveText('Board: not connected');
  await menu(page, 'Device', 'Connect');
  await expect(page.getByTestId('board-files-folder')).toHaveText('Board on USB 303a:1001', {
    timeout: 30_000,
  });
  const tree = page.getByTestId('board-files-tree');
  await tree.getByRole('treeitem', { name: 'flash' }).click();
  await tree.getByRole('treeitem', { name: 'shell.py' }).dblclick();
  await expect(page.getByTestId('tab-file-1')).toHaveText('shell.py');
  const editor = page.locator('[role="tabpanel"]:not([hidden]) lms-code-editor .cm-content');
  await expect(editor).toContainText('print("shell")');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('# edited\n');
  await page.keyboard.press('ControlOrMeta+s');
  // a save is an upload_files of one file: slow on the scripted board, WebKit the slowest
  await expect(page.getByTestId('tab-file-1')).toHaveText('shell.py', { timeout: 30_000 });
  await expect
    .poll(() => new TextDecoder().decode(board.file('/flash/shell.py') ?? new Uint8Array()))
    .toBe('# edited\nprint("shell")\n');

  const dialog = page.locator('lms-dialogs dialog[open]');
  await tree.getByRole('treeitem', { name: 'shell.py' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await dialog.locator('#text').fill('main.py');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: 'main.py' })).toBeVisible();
  await expect(page.getByTestId('tab-file-1')).toHaveText('main.py');
  expect(board.files()).toEqual(['/flash/main.py']);

  // the root of a filesystem is refused, as upstream's remove_path does
  await tree.getByRole('treeitem', { name: 'flash' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(dialog).toContainText('Delete the folder /flash from the board');
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect.poll(() => consoleText(page)).toContain('/flash is the root of a filesystem');
  await tree.getByRole('treeitem', { name: 'main.py' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(dialog).toContainText('Delete /flash/main.py from the board?');
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect(tree.getByRole('treeitem', { name: 'main.py' })).toHaveCount(0);
  expect(board.files()).toEqual([]);
});

test('Run on the Board: the folder of a program goes to the board, then runs at its prompt', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const board = await plugBoard(page, { width: 480, height: 480 });
  await start(page);
  await openOnBoard(page);
  const dialog = page.locator('lms-dialogs dialog[open]');
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await dialog.locator('#place').selectOption('examples');
  await dialog.getByRole('option', { name: '📁 shell' }).click();
  await dialog.getByRole('button', { name: 'Choose', exact: true }).click();
  await page
    .getByTestId('files-tree')
    .getByRole('treeitem', { name: 'shell.py' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Run on the Board' }).click();
  await expect
    .poll(() => board.files().includes('/shell/shell.py'), { timeout: 180_000 })
    .toBe(true);
  const typed = () => new TextDecoder().decode(Uint8Array.from(board.received));
  await expect
    .poll(typed, { timeout: 150_000 })
    .toContain(
      "\x03import os; os.chdir('/shell'); exec(open('shell.py').read(), {'__name__': '__main__', '__file__': '/shell/shell.py'})\r",
    );
});

test('Upload Files…: files of the PC to a folder of the board, with the power-on question', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const board = await plugBoard(page, { width: 480, height: 480 });
  await start(page);
  await openOnBoard(page);
  await menu(page, 'Device', 'Upload Files…');
  const dialog = page.locator('lms-dialogs dialog[open]');
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add Files…' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'main.py', mimeType: 'text/x-python', buffer: Buffer.from('print("main")\n') },
    { name: 'logo.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) },
  ]);
  await expect(dialog.getByTestId('upload-files-list').locator('option')).toHaveCount(2);
  await dialog.locator('#destination').fill('/');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).toContainText('The board runs these files at power-on');
  await expect(dialog).toContainText('/main.py');
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect
    .poll(() => consoleText(page), { timeout: 60_000 })
    .toContain('2 files copied to / on the board.');
  expect(board.file('/logo.bin')).toEqual(new Uint8Array([0, 1, 2, 255]));
  expect(new TextDecoder().decode(board.file('/main.py') ?? new Uint8Array())).toBe(
    'print("main")\n',
  );
});

test('F5 runs the app on the board, a change of the page reaches it live, Shift+F5 stops it', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // source only, so that the fake board can run the app; every font, as the app uses them
  const fonts = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48];
  await plugBoard(page, { width: 480, height: 480, mpy: null, fonts });
  await start(page);
  await openOnBoard(page);
  await page.keyboard.press('F5');
  const save = page.locator('lms-dialogs dialog[open]');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('device-status')).toContainText('app active', { timeout: 120_000 });
  await expect.poll(() => consoleText(page)).toContain('Board application started');
  // a widget moved on the canvas: the page is sent again, the app keeps running
  await page.locator('[data-testid^="tab-page-"]').first().click();
  // the widgets of the page shown, one pixel to the right, as the arrow key on the canvas does
  await page.evaluate(async () => {
    const studio = window.lmsStudio.studio;
    const pageId = studio?.currentPage();
    if (!studio?.designer || !pageId) throw new Error('no page shown');
    studio.designer.selectAll();
    await studio.designer.moveSelected(1, 0, pageId);
  });
  await expect
    .poll(() => page.evaluate(() => window.lmsStudio.studio?.session.state?.canUndo))
    .toBe(true);
  await expect(page.locator('footer')).toContainText('Board updated.', { timeout: 60_000 });
  await page.keyboard.press('Shift+F5');
  await expect(page.locator('footer')).toContainText('Board stopped', { timeout: 60_000 });
  await expect(page.getByTestId('device-status')).not.toContainText('app active');
});

test('the board row of the Files panel stays in sight beside a long project tree', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await plugBoard(page, { width: 1024, height: 600 });
  await start(page);
  await menu(page, 'File', 'Open Example', 'eim-01');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: eim-01/project.json');
  const refresh = page
    .locator('lms-files-panel.board-files')
    .getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeInViewport({ ratio: 1 });
  // the Toolbox scrolls inside its own box: its last entry is reached by scrolling, not cut off
  const keyboard = page
    .locator('lms-toolbox')
    .getByRole('option', { name: 'Keyboard', exact: true });
  await keyboard.scrollIntoViewIfNeeded();
  await expect(keyboard).toBeInViewport({ ratio: 1 });
});

test('without Web Serial the Device menu says so, and its board items are off', async ({
  page,
}) => {
  // as Safari, which has no navigator.serial
  await page.addInitScript(() => {
    delete (Navigator.prototype as { serial?: unknown }).serial;
  });
  await start(page);
  await openOnBoard(page);
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
