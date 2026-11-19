// Phase 11 gate: a project built from nothing through the capture contract's named controls and
// reads alone (docs/capture.md): a new project for a board, a page, a Label and a Button placed,
// their texts, a handler, a function with nested blocks typed in the Code tab as a person types
// it, Run → Start and a tap. The same steps twice with clock=manual&seed=1 give the same frames
// and the same text. Also editor=plain, python-error, paste(), and dragging at a zoom of the page.
import type { Page } from '@playwright/test';
import type { CaptureProject } from '../../src/capture/api.ts';
import { expect, test } from './fixtures.ts';

const ESP32 = 'esp32-4848s040-480-480';

async function start(page: Page, query: string) {
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => window.lmsCapture !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await page.evaluate(() => {
    const events: Record<string, unknown>[] = [];
    window.lmsCapture?.onEvent((event) => events.push(event));
    Object.assign(window, { captured: events });
  });
  await idle(page);
}

const idle = (page: Page) => page.evaluate(() => window.lmsCapture?.idle());
/** Between keys: what runs now, not the budget's measure due 1.5 s after the last one. */
const settle = (page: Page) => page.evaluate(() => window.lmsCapture?.settle());
const named = (page: Page, name: string) => page.locator(`[data-capture="${name}"]`);
const project = (page: Page) =>
  page.evaluate(() => window.lmsCapture?.project() ?? null) as Promise<CaptureProject | null>;
const editor = (page: Page) => page.evaluate(() => window.lmsCapture?.editor() ?? null);
const events = (page: Page, type: string) =>
  page.evaluate(
    (type) =>
      (window as unknown as { captured: Record<string, unknown>[] }).captured.filter(
        (event) => event.type === type,
      ),
    type,
  );

async function menu(page: Page, ...path: string[]) {
  await named(page, `menu-${path[0]}`).click();
  for (let depth = 1; depth < path.length; depth++)
    await named(page, `menu-${path.slice(0, depth + 1).join('.')}`).click();
  await idle(page);
}

/** A widget from the Toolbox at a point of the page, aimed with the page's own canvas. */
async function place(page: Page, type: string, x: number, y: number): Promise<string> {
  const before = (await project(page))?.widgets.map((widget) => widget.name) ?? [];
  await named(page, `toolbox.${type}`).dblclick();
  const stage = page.locator('[role="tabpanel"]:not([hidden]) .stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('no canvas');
  const scale = box.width / (480 + 80);
  await page.mouse.click(box.x + (40 + x) * scale, box.y + (40 + y) * scale);
  await idle(page);
  const added = (await project(page))?.widgets.find((widget) => !before.includes(widget.name));
  if (!added) throw new Error(`no ${type} placed`);
  return added.name;
}

async function setProperty(page: Page, widget: string, key: string, value: string) {
  await named(page, `tree.widget.${widget}`).click();
  await named(page, 'properties-tab.properties').click();
  const field = page.locator(`[data-capture="properties"] [data-property="${key}"]`);
  await field.fill(value);
  await field.press('Enter');
  await idle(page);
}

/**
 * Code typed key by key as a person types it, knowing what the editor does: after Enter it reads
 * the indentation the editor gave and corrects it with Backspace or spaces; the closing brackets
 * the editor inserted are typed over; the completion list is closed with Escape before Enter.
 */
async function typeCode(page: Page, code: string) {
  const lines = code.split('\n');
  for (const [index, line] of lines.entries()) {
    const want = /^ */.exec(line)?.[0].length ?? 0;
    if (index > 0) {
      if ((await editor(page))?.completion.open) {
        await page.keyboard.press('Escape');
        await settle(page);
      }
      await page.keyboard.press('Enter');
      await settle(page);
    }
    let have = ((await editor(page))?.caret.column ?? 1) - 1;
    while (have > want) {
      await page.keyboard.press('Backspace');
      await settle(page);
      have = ((await editor(page))?.caret.column ?? 1) - 1;
    }
    if (have < want) await page.keyboard.type(' '.repeat(want - have));
    for (const character of line.slice(want)) {
      await page.keyboard.type(character);
      await settle(page);
    }
  }
  if ((await editor(page))?.completion.open) await page.keyboard.press('Escape');
  await idle(page);
}

/** The editor shown, emptied, with the caret in it. */
async function clearEditor(page: Page) {
  await page.locator('[role="tabpanel"]:not([hidden]) lms-code-editor .cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await idle(page);
}

const GENERAL = `def total(n):
    s = 0
    for i in range(n):
        if i % 2:
            s += i
        else:
            s += 10
    return s`;

const HANDLER = `print("tapped", total(4))
ui.title.set_text("Total: " + str(total(4)))`;

/** Run → Start: a new project is saved first, through the file chooser's names. */
async function startRun(page: Page, file: string) {
  await menu(page, 'run', 'start');
  const opened = (await events(page, 'dialog-opened')).at(-1);
  expect(opened).toMatchObject({ kind: 'choose', title: 'Save Project' });
  await named(page, 'dialog.field.name').fill(file);
  await named(page, 'dialog.button.save').click();
  await idle(page);
}

async function frameHash(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const frame = window.lmsCapture?.frame();
    if (!frame) return 'none';
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(frame.pixels));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

/** The whole build, then the run: what the steps leave, to compare two takes. */
async function build(page: Page) {
  // File → New for a Board: no question, nothing to save yet
  await menu(page, 'file', 'new-for-a-board', ESP32);
  let state = await project(page);
  expect(state?.resolution).toEqual([480, 480]);
  expect(state?.board).toBe('esp32_4848s040_480');
  expect(state?.widgets).toEqual([]);

  // Project → Add Page, then Rename Page through its dialog's names
  await menu(page, 'project', 'add-page');
  state = await project(page);
  expect(state?.pages).toHaveLength(2);
  const added = state?.pages[1];
  await named(page, `tree.page.${added?.name}`).click();
  await menu(page, 'project', 'rename-page');
  const opened = (await events(page, 'dialog-opened')).at(-1);
  expect(opened).toMatchObject({ kind: 'text', fields: ['name'], buttons: ['cancel', 'ok'] });
  await named(page, 'dialog.field.name').fill('game');
  await named(page, 'dialog.button.ok').click();
  await idle(page);
  await named(page, 'tree.page.game').click();
  await menu(page, 'project', 'set-initial-page');
  state = await project(page);
  // the initial page goes first, as on the desktop
  expect(state?.pages.map((page) => [page.name, page.initial])).toEqual([
    ['game', true],
    ['main', false],
  ]);
  expect(state?.page).toBe(added?.id);

  // a Label and a Button, named and with their texts
  const label = await place(page, 'label', 40, 40);
  await setProperty(page, label, 'Name', 'title');
  await setProperty(page, 'title', 'text', 'Tap the button');
  const button = await place(page, 'button', 40, 140);
  await setProperty(page, button, 'Name', 'tap');
  await setProperty(page, 'tap', 'text', 'Count');
  state = await project(page);
  const tap = state?.widgets.find((widget) => widget.name === 'tap');
  expect(tap).toMatchObject({ type: 'button', page: added?.id, parent: null, x: 40, y: 140 });
  expect(state?.selection).toEqual(['tap']);
  // widgetBox: the canvas's own drawing of the widget, in the viewport
  const box = await page.evaluate(() => window.lmsCapture?.widgetBox('tap'));
  const drawn = await named(page, 'designer-handle.se').boundingBox();
  const corner = {
    x: (drawn?.x ?? 0) + (drawn?.width ?? 0) / 2,
    y: (drawn?.y ?? 0) + (drawn?.height ?? 0) / 2,
  };
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) - corner.x)).toBeLessThan(1.5);
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - corner.y)).toBeLessThan(1.5);

  // Events: a double click on CLICKED gives the handler and opens it, as a person does
  await named(page, 'properties-tab.events').click();
  await named(page, 'event.CLICKED').dblclick();
  await idle(page);
  await expect(named(page, 'event.CLICKED.handler')).toHaveText('tap_clicked');
  expect((await project(page))?.widgets.find((widget) => widget.name === 'tap')?.handlers).toEqual({
    CLICKED: 'tap_clicked',
  });
  expect((await editor(page))?.file).toBe('handler:tap_clicked');
  await clearEditor(page);
  await typeCode(page, HANDLER);

  // the general code: a function with nested blocks
  await named(page, 'code.object').selectOption('module');
  await idle(page);
  const general = await editor(page);
  expect(general?.file).toBe('general');
  await page.locator('[data-capture="code-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await idle(page);
  await typeCode(page, GENERAL);
  const typed = await editor(page);
  expect(typed?.text.endsWith(`\n${GENERAL}`)).toBe(true);
  expect(typed?.caret).toEqual({ line: typed?.text.split('\n').length, column: 13 });

  // Run → Start with the manual clock, then a tap on the button
  await startRun(page, 'tapper.json');
  await expect(page.getByTestId('sim-status')).toContainText('RGB565', { timeout: 30_000 });
  const frames: string[] = [];
  const steps = async (count: number) => {
    for (let step = 0; step < count; step++) {
      await page.evaluate(() => window.lmsCapture?.step(33));
      frames.push(await frameHash(page));
    }
  };
  await steps(5);
  const x = (tap?.x ?? 0) + (tap?.width ?? 0) / 2;
  const y = (tap?.y ?? 0) + (tap?.height ?? 0) / 2;
  await page.evaluate(({ x, y }) => window.lmsCapture?.pointer(x, y, true), { x, y });
  await steps(2);
  await page.evaluate(({ x, y }) => window.lmsCapture?.pointer(x, y, false), { x, y });
  await steps(5);
  await expect
    .poll(async () => (await events(page, 'output')).map((event) => event.text))
    .toContain('tapped 24');
  expect(frames.at(-1)).not.toBe(frames[0]);
  expect(await events(page, 'python-error')).toEqual([]);
  await menu(page, 'run', 'stop');
  return { frames, text: typed?.text };
}

test('the gate: a project built from nothing, twice the same with clock=manual&seed=1', async ({
  page,
  context,
}) => {
  test.setTimeout(400_000);
  const query = 'capture=1&clock=manual&seed=1';
  await start(page, query);
  const first = await build(page);
  // a fresh page for the second take; the first one closed, as a recorder starts each take
  const second = await context.newPage();
  await page.close();
  await start(second, query);
  expect(await build(second)).toEqual(first);
});

test('dialogs name their fields and buttons, in Italian too; Save As stays in the IDE', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await start(page, 'capture=1&lang=it');
  await menu(page, 'file', 'save-as');
  const opened = (await events(page, 'dialog-opened')).at(-1);
  expect(opened).toMatchObject({ kind: 'choose' });
  expect(opened?.fields).toEqual(expect.arrayContaining(['place', 'name']));
  expect(opened?.buttons).toEqual(expect.arrayContaining(['new-folder', 'cancel', 'save']));
  // the places are the IDE's: no folder of the PC to pick in capture mode
  await expect(named(page, 'dialog.field.place').locator('option[value="+folder"]')).toHaveCount(0);
  await named(page, 'dialog.field.name').fill('built.json');
  await named(page, 'dialog.button.save').click();
  await idle(page);
  await expect(page.getByTestId('project-file')).toContainText('built.json');

  // a form: the resize question of a new resolution names its choices
  await menu(page, 'project', 'project-settings');
  await expect(named(page, 'dialog.field.width')).toBeVisible();
  await expect(named(page, 'dialog.field.board-profile')).toBeVisible();
  await named(page, 'dialog.button.cancel').click();
  await idle(page);
  expect((await events(page, 'dialog-closed')).length).toBe(2);
});

test('editor=plain: the text typed is the text sent', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, 'capture=1&editor=plain');
  await named(page, 'tab-code').click();
  await idle(page);
  const sent = 'def f(a):\n    if a:\n        return [a, (a)]\n    return {"a": a}\n';
  await page.locator('[data-capture="code-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(sent);
  await idle(page);
  const state = await editor(page);
  expect(state?.text).toBe(sent);
  expect(state?.completion.open).toBe(false);
});

test('the editor completes, closes brackets and indents the same in every take', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await start(page, 'capture=1');
  await named(page, 'tab-code').click();
  await page.locator('[data-capture="code-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  for (const character of 'x = lv.') {
    await page.keyboard.type(character);
    await settle(page);
  }
  let state = await editor(page);
  expect(state?.completion.open).toBe(true);
  expect(state?.completion.options.length).toBeGreaterThan(10);
  expect(state?.completion.selected).toBe(0);
  await page.keyboard.press('Escape');
  await idle(page);
  expect((await editor(page))?.completion.open).toBe(false);
  // a bracket is closed by the editor, and typed over. (Not lv.obj(): at the top of the general
  // code, before the display exists, it halts LVGL, and in the browser the halt blocks the page.)
  for (const character of 'color_hex(') await page.keyboard.type(character);
  await idle(page);
  state = await editor(page);
  expect(state?.text).toBe('x = lv.color_hex()');
  expect(state?.caret).toEqual({ line: 1, column: 18 });
  await page.keyboard.type('1)');
  await idle(page);
  state = await editor(page);
  expect(state?.text).toBe('x = lv.color_hex(1)');
  expect(state?.caret).toEqual({ line: 1, column: 20 });
  // after a line ending in a colon Enter indents by four
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('if x:');
  await idle(page);
  if ((await editor(page))?.completion.open) await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await idle(page);
  expect((await editor(page))?.caret).toEqual({ line: 3, column: 5 });
  // Backspace in the indentation takes four spaces
  await page.keyboard.press('Backspace');
  await idle(page);
  expect((await editor(page))?.caret).toEqual({ line: 3, column: 1 });
  // editorPoint is where a click puts the caret
  const point = await page.evaluate(() => window.lmsCapture?.editorPoint(1, 5));
  expect(point).not.toBeNull();
  await page.mouse.click(point?.x ?? 0, point?.y ?? 0);
  await idle(page);
  expect((await editor(page))?.caret).toEqual({ line: 1, column: 5 });
  expect((await editor(page))?.visible.first).toBe(1);
});

test('paste() is one undo step; a program that raises gives python-error at its line', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await start(page, 'capture=1&clock=manual');
  await named(page, 'tab-code').click();
  await page.locator('[data-capture="code-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await idle(page);
  const code = 'import lvgl as lv\n\nvalue = 1\nbroken = value / 0\n';
  await page.evaluate((code) => window.lmsCapture?.paste(code), code);
  await idle(page);
  expect((await editor(page))?.text).toBe(code);
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  expect((await editor(page))?.text).toBe('');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await idle(page);
  expect((await editor(page))?.text).toBe(code);
  await startRun(page, 'broken.json');
  await expect
    .poll(async () => (await events(page, 'python-error')).length, { timeout: 30_000 })
    .toBe(1);
  const [error] = await events(page, 'python-error');
  expect(error).toMatchObject({ file: 'general', line: 4 });
  expect(String(error?.message)).toMatch(/ZeroDivisionError/);
  expect(String(error?.traceback)).toMatch(/^Traceback/);
  // the check of the editor says it too, as code-checked
  const checked = await events(page, 'code-checked');
  expect(checked.at(-1)).toMatchObject({ file: 'general', errors: [] });
});

test('a widget is moved and resized with the mouse at a zoom of the page', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, 'capture=1&zoom=1.4');
  await menu(page, 'file', 'new-for-a-board', ESP32);
  const pageId = (await project(page))?.pages[0]?.id;
  await named(page, `tab-page-${pageId}`).click();
  await idle(page);
  const label = await place(page, 'label', 100, 100);
  const before = (await project(page))?.widgets.find((widget) => widget.name === label);
  const box = await page.evaluate((name) => window.lmsCapture?.widgetBox(name), label);
  if (!box || !before) throw new Error('no label');
  const scale = box.width / before.width;
  expect(scale).toBeGreaterThan(1.3);
  // a drag of its body by 30 × 20 pixels of the page
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 15 * scale, from.y + 10 * scale, { steps: 3 });
  await page.mouse.move(from.x + 30 * scale, from.y + 20 * scale, { steps: 3 });
  await page.mouse.up();
  await idle(page);
  const moved = (await project(page))?.widgets.find((widget) => widget.name === label);
  expect(Math.abs((moved?.x ?? 0) - before.x - 30)).toBeLessThanOrEqual(1);
  expect(Math.abs((moved?.y ?? 0) - before.y - 20)).toBeLessThanOrEqual(1);
  // the south-east handle by 40 × 10
  const handle = await named(page, 'designer-handle.se').boundingBox();
  if (!handle) throw new Error('no handle');
  const grip = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40 * scale, grip.y + 10 * scale, { steps: 4 });
  await page.mouse.up();
  await idle(page);
  const resized = (await project(page))?.widgets.find((widget) => widget.name === label);
  expect(Math.abs((resized?.width ?? 0) - before.width - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs((resized?.height ?? 0) - before.height - 10)).toBeLessThanOrEqual(1);
  expect(resized?.x).toBe(moved?.x);
});
