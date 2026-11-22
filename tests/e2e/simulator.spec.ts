// Phase 3 gate: the shell example runs, and `sleep 2` + Ctrl-C brings the prompt back each time
// with no traceback; a game starts, and its first frame is the desktop runtime's, pixel for pixel
// (tests/fixtures/frames, from scripts/frames.py; threshold 0, upstream's visual tests' default).
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { differentPixels, readPng, rgb565ToRgb } from './png.ts';

const PROMPT = '\x1b[1;32mmpy@browser\x1b[0m:\x1b[1;34m/\x1b[0m$ ';

async function start(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

async function menu(page: Page, top: string, ...path: string[]) {
  await page.getByRole('menubar').getByRole('menuitem', { name: top, exact: true }).click();
  for (const item of path) await page.getByRole('menuitem', { name: item, exact: true }).click();
}

const dialog = (page: Page) => page.locator('lms-dialogs dialog[open]');
const transcript = (page: Page) =>
  page.evaluate(() => window.lmsStudio.studio?.run?.transcript ?? '');
const count = (text: string, part: string) => text.split(part).length - 1;
/** The line editor redraws the prompt at every key; a new prompt starts a new line. */
const NEW_PROMPT = `\n\r\x1b[K${PROMPT}`;

/** Types a command and waits for the prompt after its output. */
async function command(page: Page, line: string) {
  const before = count(await transcript(page), NEW_PROMPT);
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await expect.poll(async () => count(await transcript(page), NEW_PROMPT)).toBe(before + 1);
}

async function runShell(page: Page) {
  await menu(page, 'Run', 'Run Program…');
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Run Program' })).toBeVisible();
  await d.locator('#place').selectOption('examples');
  await d.getByRole('option', { name: '📁 shell' }).click();
  await d.getByRole('option', { name: 'shell.py' }).click();
  await d.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('sim-status')).toHaveText('Program running');
  await expect.poll(() => transcript(page)).toContain(PROMPT);
}

test('the shell example: sleep 2 and Ctrl-C ten times, the prompt comes back each time', async ({
  page,
}) => {
  await start(page);
  await runShell(page);
  const terminal = page.getByTestId('sim-terminal');
  await terminal.click();
  for (let round = 1; round <= 10; round++) {
    const before = count(await transcript(page), NEW_PROMPT);
    await page.keyboard.type('sleep 2');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await transcript(page)).endsWith('sleep 2\n')).toBe(true);
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => (await transcript(page)).endsWith(`^C${NEW_PROMPT}`), {
        message: `round ${round}`,
        timeout: 1500, // well before the 2 s of sleep: the Ctrl-C stopped it
      })
      .toBe(true);
    expect(count(await transcript(page), NEW_PROMPT)).toBe(before + 1);
  }
  expect(await transcript(page)).not.toContain('Traceback');
  await menu(page, 'Run', 'Stop');
  await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');
});

test('a program keeps its flash between runs, and Erase Program Flash empties it', async ({
  page,
}) => {
  await start(page);
  await runShell(page);
  await page.getByTestId('sim-terminal').click();
  await command(page, 'echo kept > note.txt');
  await page.keyboard.press('Shift+F5');
  await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');

  await runShell(page);
  await page.getByTestId('sim-terminal').click();
  await command(page, 'cat note.txt');
  expect(await transcript(page)).toContain('cat note.txt\nkept\n');
  await page.keyboard.press('Shift+F5');

  await menu(page, 'Run', 'Erase Program Flash…');
  await dialog(page).getByRole('button', { name: 'Yes' }).click();
  await runShell(page);
  await page.getByTestId('sim-terminal').click();
  await command(page, 'cat note.txt');
  expect(await transcript(page)).not.toContain('kept');
});

test('a program without pages of the workspace runs, and its prints reach the terminal', async ({
  page,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const workspace = window.lmsStudio.studio?.stores.get('workspace');
    const code = 'import sys\nprint("hello from", sys.platform)\nprint(sum(range(10)))\n';
    await workspace?.write('hello/main.py', new TextEncoder().encode(code));
  });
  await page.evaluate(() =>
    window.lmsStudio.studio?.run?.runProgram({ store: 'workspace', path: 'hello/main.py' }),
  );
  await expect.poll(() => transcript(page)).toContain('hello from webassembly\n45\n');
  await expect.poll(() => transcript(page)).toContain('>>> ');
  await page.getByTestId('sim-terminal').click();
  await page.keyboard.type('6 * 7');
  await page.keyboard.press('Enter');
  await expect.poll(() => transcript(page)).toContain('6 * 7\r\n42\n');
});

for (const game of ['snake', 'fifteen']) {
  test(`${game} starts, and its first frame is the desktop runtime's`, async ({ page }) => {
    await start(page);
    await menu(page, 'File', 'Open Example', game);
    await expect(page.getByTestId('project-file')).toHaveText(`Examples: ${game}/project.json`);
    await page.keyboard.press('F5');
    await expect(page.getByTestId('sim-status')).toContainText('RGB565');
    await expect(page.getByTestId('sim-frame')).toBeVisible();
    await page.keyboard.press('Shift+F5');
    await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');

    const pixels = await page.evaluate(async () => {
      const frame = await window.lmsStudio.studio?.run?.firstFrame();
      return frame ? btoa(Array.from(frame, (byte) => String.fromCharCode(byte)).join('')) : null;
    });
    expect(pixels, await transcript(page)).not.toBeNull();
    const expected = readPng(`tests/fixtures/frames/${game}.png`);
    const actual = rgb565ToRgb(new Uint8Array(Buffer.from(pixels ?? '', 'base64')));
    expect(actual.length).toBe(expected.width * expected.height * 3);
    expect(differentPixels(expected.rgb, actual)).toBe(0);
  });
}

test('the key that starts a project lets its Buzzer play', async ({ page }) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'simon');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: simon/project.json');
  const tones = () =>
    page.evaluate(() => {
      const player = window.lmsStudio.studio?.run?.simulator.tones;
      return [player?.ready, typeof AudioContext];
    });
  expect((await tones())[0]).toBe(false);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('sim-status')).toContainText('RGB565', { timeout: 60_000 });
  // nothing prepared the sound: every tone of a game was counted and none was played
  const [ready, audio] = await tones();
  expect(ready).toBe(audio === 'function');
  await page.keyboard.press('Shift+F5');
  await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');
});
