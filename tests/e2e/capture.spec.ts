// Phase 10 gate: the capture contract (docs/capture.md). With ?capture=1&clock=manual&seed=1 an
// example runs 60 steps of 33 ms, and two runs in two fresh pages give the same 60 frames, byte for
// byte. Also: the frames, events, idle() and the stable names the contract promises.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

const STEPS = 60;
const STEP_MS = 33;

async function start(page: Page, query: string) {
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => window.lmsCapture !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await page.evaluate(() => window.lmsCapture?.idle());
}

/** A menu by its capture names, the same in every language. */
async function menu(page: Page, ...path: string[]) {
  await page.locator(`[data-capture="menu-${path[0]}"]`).click();
  for (let depth = 1; depth < path.length; depth++) {
    await page.locator(`[data-capture="menu-${path.slice(0, depth + 1).join('.')}"]`).click();
  }
}

async function openExample(page: Page, name: string) {
  await menu(page, 'file', 'open-example', name);
  await expect(page.getByTestId('project-file')).toHaveText(`Examples: ${name}/project.json`);
  await page.evaluate(() => window.lmsCapture?.idle());
}

/**
 * Starts the open project, then the hash of the frame after each step. Play of the fifteen is
 * tapped at steps 5 to 7: the game shuffles with LVGL's tick, and its clock runs.
 */
async function steppedFrames(page: Page): Promise<string[]> {
  await menu(page, 'run', 'start');
  await expect(page.getByTestId('sim-status')).toContainText('RGB565', { timeout: 30_000 });
  return page.evaluate(
    async ({ steps, ms }) => {
      const capture = window.lmsCapture;
      if (!capture) throw new Error('no lmsCapture');
      const out: string[] = [];
      for (let step = 0; step < steps; step++) {
        if (step === 5) capture.pointer(240, 318, true);
        if (step === 7) capture.pointer(240, 318, false);
        const frame = await capture.step(ms);
        if (!frame) {
          out.push('none');
          continue;
        }
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(frame.pixels));
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'));
        out.push(`${frame.number}:${frame.width}x${frame.height}:${hex.join('')}`);
      }
      return out;
    },
    { steps: STEPS, ms: STEP_MS },
  );
}

test('the gate: 60 steps of 33 ms with seed 1 give the same frames in two runs', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const query = 'capture=1&clock=manual&seed=1';
  await start(page, query);
  await openExample(page, 'fifteen');
  const first = await steppedFrames(page);
  expect(first).toHaveLength(STEPS);
  // the tap started the game: the shuffled board is not the menu
  const pixels = first.map((frame) => frame.split(':')[2]);
  expect(pixels.at(-1)).not.toBe(pixels[0]);

  const second = await context.newPage();
  await start(second, query);
  await openExample(second, 'fifteen');
  expect(await steppedFrames(second)).toEqual(first);
});

test('frames and events reach the page; step() needs the manual clock', async ({ page }) => {
  await start(page, 'capture=1');
  await page.evaluate(() => {
    const events: unknown[] = [];
    const frames: number[] = [];
    window.lmsCapture?.onEvent((event) => events.push(event));
    window.lmsCapture?.onFrame((frame) =>
      frames.push(frame.width * frame.height * 4 - frame.pixels.length),
    );
    Object.assign(window, { captured: { events, frames } });
  });
  await openExample(page, 'eim-01');
  await menu(page, 'run', 'start');
  await expect(page.getByTestId('sim-status')).toContainText('RGB565', { timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { captured: { frames: number[] } }).captured.frames.length,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(2);
  await menu(page, 'run', 'stop');
  const captured = await page.evaluate(
    () =>
      (window as unknown as { captured: { events: { type: string }[]; frames: number[] } })
        .captured,
  );
  // every frame is width × height RGBA
  expect(captured.frames.every((difference) => difference === 0)).toBe(true);
  const types = captured.events.map((event) => event.type);
  expect(types).toContain('project-opened');
  expect(types).toContain('page-changed');
  expect(types).toContain('simulator-started');
  expect(types.at(-1)).toBe('simulator-stopped');
  // the real clock: step() is refused
  await expect(page.evaluate(() => window.lmsCapture?.step(33))).rejects.toThrow(/manual clock/);
});

test('dialogs are events; the status bar has no times; the stable names are there', async ({
  page,
}) => {
  await start(page, 'capture=1&lang=it&theme=dark&zoom=1.25');
  await page.evaluate(() => {
    const events: string[] = [];
    window.lmsCapture?.onEvent((event) => events.push(`${event.type}:${String(event.title)}`));
    Object.assign(window, { dialogEvents: events });
  });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('it');
  await expect(page.getByTestId('python-status')).toHaveText(/^Python [\d.]+ pronto$/);
  for (const name of ['toolbox', 'project-tree', 'designer-canvas', 'output', 'menu-run']) {
    await expect(page.locator(`[data-capture="${name}"]`).first()).toBeAttached();
  }
  await menu(page, 'help', 'about-lvgl-mpy-studio');
  await page.keyboard.press('Escape');
  await menu(page, 'project', 'project-settings');
  await expect(page.locator('[data-capture="dialog"][open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-capture="dialog"][open]')).toHaveCount(0);
  const events = await page.evaluate(
    () => (window as unknown as { dialogEvents: string[] }).dialogEvents,
  );
  expect(events.filter((event) => event.startsWith('dialog-'))).toHaveLength(2);
  expect(events.at(-1)).toMatch(/^dialog-closed:/);
});

test('capture mode keeps away from the user workspace and settings', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => window.lmsStudio.started);
  await page.evaluate(() => localStorage.setItem('lms.capture-check', '"kept"'));
  const before = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  await start(page, 'capture=1');
  await menu(page, 'settings', 'language', 'italiano');
  await page.evaluate(() => window.lmsCapture?.idle());
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))).toBe(
    before,
  );
});
