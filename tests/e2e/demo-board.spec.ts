// The demonstration board (src/board/demo-board.ts): the real flow of a board, Connect, Upload
// and Run, with no hardware. The board is the browser's MicroPython in an iframe; everything
// between is the IDE's: BoardPort, the Python worker, mpremote and upstream's DeviceSession.
// JSPI is needed for Python to wait for the board: Chromium.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'JSPI: Chromium only');

async function start(page: Page, query = '') {
  await page.goto(`./${query}`);
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

async function menu(page: Page, top: string, ...path: string[]) {
  await page.getByRole('menubar').getByRole('menuitem', { name: top, exact: true }).click();
  for (const item of path) await page.getByRole('menuitem', { name: item, exact: true }).click();
}

const ESP32 = 'ESP32-4848S040 (480×480)';

/** weather, with its board as the run target, as in board.spec.ts. */
async function openOnBoard(page: Page) {
  await menu(page, 'File', 'Open Example', 'weather');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: weather/project.json');
  await page
    .getByRole('menubar')
    .getByRole('menuitem', { name: /^Run on: / })
    .click();
  const item = page.getByRole('menuitemcheckbox', {
    name: new RegExp(`^${ESP32.replace(/[()]/g, '\\$&')}`),
  });
  if ((await item.getAttribute('aria-checked')) === 'true') await page.keyboard.press('Escape');
  else await item.click();
}

const consoleText = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector('lms-app')?.shadowRoot?.querySelector('lms-device-console')?.text ??
      '',
  );

test('the demo board: connect, information, the console, upload and run, disconnect', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await start(page, '?capture=1');
  await openOnBoard(page);
  await menu(page, 'Device', 'Connect to Demo Board');
  await expect(page.getByTestId('device-status')).toHaveText(
    'Connected to Demo board (simulated)',
    { timeout: 60_000 },
  );
  // it says what it is
  await expect(page.getByRole('tab', { name: 'Demo board (simulated)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('note')).toContainText('A simulated board, not hardware');
  await expect.poll(() => consoleText(page)).toContain('"compatible": true');

  // the console follows the board when the IDE is not using it
  await expect(page.getByRole('button', { name: 'Ctrl-C', exact: true })).toBeEnabled();
  await page.getByTestId('device-terminal').click();
  await page.keyboard.type('6*7');
  await page.keyboard.press('Enter');
  await expect.poll(() => consoleText(page)).toContain('42');

  // Upload and Run: saved first, as upload_board does
  await menu(page, 'Device', 'Upload and Run');
  const save = page.locator('lms-dialogs dialog[open]');
  await expect(save.getByRole('heading', { name: 'Save Project' })).toBeVisible();
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => consoleText(page), { timeout: 120_000 }).toContain('LMS_APP_READY');
  await expect(page.getByTestId('device-status')).toContainText('app active');
  // the board's display draws the app, and its frames reach the capture contract
  await expect
    .poll(() => page.evaluate(() => window.lmsCapture?.boardFrame()?.number ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const frame = await page.evaluate(() => {
    const last = window.lmsCapture?.boardFrame();
    if (!last) return null;
    let lit = 0;
    for (let index = 0; index < last.pixels.length; index += 4) {
      if (
        (last.pixels[index] ?? 0) + (last.pixels[index + 1] ?? 0) + (last.pixels[index + 2] ?? 0) >
        60
      )
        lit++;
    }
    return { width: last.width, height: last.height, lit };
  });
  expect(frame?.width).toBe(480);
  expect(frame?.height).toBe(480);
  expect(frame?.lit).toBeGreaterThan(1000);

  // Restart Interpreter: a soft reset, a new MicroPython with the same flash
  await page.getByTestId('device-terminal').click();
  await page.keyboard.type('before_reset = 1');
  await page.keyboard.press('Enter');
  await menu(page, 'Device', 'Restart Interpreter');
  await expect(page.getByRole('button', { name: 'Ctrl-C', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await page.getByTestId('device-terminal').click();
  await page.keyboard.type(
    "import os; print('kept', 'before_reset' in globals(), len(os.listdir('/lms_apps')))",
  );
  await page.keyboard.press('Enter');
  // the variable went with the old interpreter, the app stayed in the flash
  await expect.poll(() => consoleText(page), { timeout: 30_000 }).toMatch(/kept False [1-9]/);

  await menu(page, 'Device', 'Disconnect');
  await expect(page.getByTestId('device-status')).toHaveText('Board not connected');
  await expect(page.getByRole('tab', { name: 'Demo board (simulated)' })).toHaveCount(0);
});
