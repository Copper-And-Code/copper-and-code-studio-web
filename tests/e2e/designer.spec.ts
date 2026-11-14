// Phase 5, sub-gate 1: the canvas. Every page of every example, as the designer's Real LVGL
// Preview draws it, is the desktop runtime's frame of the page, pixel for pixel
// (tests/fixtures/previews, from scripts/previews.py; threshold 0, upstream's visual tests'
// default). Zoom, Fit to Window and the resolution work as on the desktop.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { differentPixels, readPng } from './png.ts';

interface Index {
  projects: Record<
    string,
    { width: number; height: number; pages: { page: string; file: string }[] }
  >;
}

const FIXTURES = new URL('../fixtures/previews/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', FIXTURES), 'utf-8')) as Index;

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

const dialog = (page: Page) => page.locator('lms-dialogs dialog[open]');
const shownPanel = (page: Page) => page.locator('.page-panel:not([hidden])');

/** The RGB of the canvas shown, once it holds the frame of the page as the project has it now. */
async function shownFrame(page: Page): Promise<Uint8Array> {
  const canvas = shownPanel(page).getByTestId('preview');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) => {
          const studio = window.lmsStudio.studio;
          const id = studio?.currentPage();
          const key = id ? studio?.designer?.pages.get(id)?.key : undefined;
          return (
            (element as HTMLCanvasElement).dataset.key === key && element.dataset.drawn === '1'
          );
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  const text = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!data) return '';
    let binary = '';
    for (let offset = 0; offset < data.length; offset += 4) {
      binary += String.fromCharCode(
        data[offset] ?? 0,
        data[offset + 1] ?? 0,
        data[offset + 2] ?? 0,
      );
    }
    return btoa(binary);
  });
  return new Uint8Array(Buffer.from(text, 'base64'));
}

for (const [name, project] of Object.entries(index.projects)) {
  test(`the pages of ${name} on the canvas are the desktop's frames`, async ({ page }) => {
    test.setTimeout(30_000 + project.pages.length * 15_000);
    await start(page);
    await menu(page, 'File', 'Open Example', name);
    await expect(page.getByTestId('project-file')).toContainText('project.json');
    for (const entry of project.pages) {
      await page.getByRole('tab', { name: entry.page, exact: true }).click();
      const expected = readPng(new URL(entry.file, FIXTURES).pathname);
      const actual = await shownFrame(page);
      expect(actual.length, `${name}/${entry.page}`).toBe(expected.rgb.length);
      const different = differentPixels(expected.rgb, actual);
      expect(different, `${name}/${entry.page}: different pixels`).toBe(0);
    }
  });
}

test('zoom, Fit to Window, the grid, and the preview turned off', async ({ page }) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await page.getByRole('tab', { name: 'Menu', exact: true }).click();
  await shownFrame(page);
  const zoom = shownPanel(page).getByTestId('zoom');
  await expect(zoom).toHaveText('100%');
  await menu(page, 'View', 'Zoom In');
  await expect(zoom).toHaveText('125%');
  await shownPanel(page).getByRole('button', { name: '−' }).click();
  await expect(zoom).toHaveText('100%');
  // the limits of _zoom: 0.5 and 4
  for (let step = 0; step < 6; step++) await menu(page, 'View', 'Zoom Out');
  await expect(zoom).toHaveText('51%');
  // the canvas has the page's size, times the zoom, with 40 pixels around it
  const canvas = shownPanel(page).getByTestId('canvas');
  expect(Number(await canvas.getAttribute('width'))).toBeCloseTo(560 * 0.512, 3);
  await menu(page, 'View', 'Fit to Window');
  await expect(zoom).not.toHaveText('51%');
  // the grid: lines every 8 pixels over the page
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Grid' }).click();
  await expect(canvas.locator('line')).toHaveCount(2 * Math.ceil(480 / 8 - 1));
  // without the preview, the widgets are painted as the desktop sketches them
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Real LVGL Preview' }).click();
  await expect(shownPanel(page).getByTestId('preview')).toHaveCount(0);
  await expect(canvas.locator('foreignObject').first()).toBeVisible();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Real LVGL Preview' }).click();
  await shownFrame(page);
});

test('a new resolution: the question, the widgets adapted, one undo step, the frame again', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await page.getByRole('tab', { name: 'Menu', exact: true }).click();
  await shownFrame(page);
  const resolution = shownPanel(page).getByTestId('resolution');
  await expect(resolution).toContainText('480×480');
  await resolution.getByRole('button', { name: '480×480' }).click();
  await resolution.getByRole('menuitemcheckbox', { name: '240×240', exact: true }).click();
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Change Resolution' })).toBeVisible();
  await expect(d).toContainText('From 480×480 to 240×240. What should happen to the widgets?');
  await expect(d.getByRole('radio', { name: /^Adapt/ })).toBeChecked();
  await d.getByRole('button', { name: 'Apply' }).click();
  await expect(resolution).toContainText('240×240');
  const frame = await shownFrame(page);
  expect(frame.length).toBe(240 * 240 * 3);
  await menu(page, 'Edit', 'Undo');
  await expect(resolution).toContainText('480×480');
  const back = await shownFrame(page);
  const expected = readPng(new URL('fifteen/Menu.png', FIXTURES).pathname);
  expect(differentPixels(expected.rgb, back)).toBe(0);

  // Custom…: the size typed, Cancel in the question changes nothing
  await resolution.getByRole('button', { name: '480×480' }).click();
  await resolution.getByRole('menuitem', { name: 'Custom…' }).click();
  await expect(d.getByRole('heading', { name: 'Custom Resolution' })).toBeVisible();
  await d.getByLabel('Width').fill('320');
  await d.getByLabel('Height').fill('240');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(d.getByRole('heading', { name: 'Change Resolution' })).toBeVisible();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(resolution).toContainText('480×480');
});

interface Workflow {
  name: string;
  example: string;
  steps: {
    resolution?: [number, number];
    mode?: 'adapt' | 'stretch' | 'keep';
    addPage?: boolean;
    initialPage?: string;
    deletePage?: string;
  }[];
}

/** A page action from the project tree's context menu on that page. */
async function pageAction(page: Page, name: string, action: string) {
  await page.getByRole('treeitem', { name, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

const WORKFLOWS = new URL('../fixtures/workflows/', import.meta.url);
const workflows = (
  JSON.parse(readFileSync(new URL('workflows.json', WORKFLOWS), 'utf-8')) as {
    workflows: Workflow[];
  }
).workflows;
const COMMON = ['240×240', '480×480', '1024×600', '1024×1024'];
const MODES = { adapt: /^Adapt/, stretch: /^Stretch/, keep: /^Leave them/ };

/** The resolution chosen as a person would: Rotate, a common size, or Custom…. */
async function chooseResolution(page: Page, width: number, height: number) {
  const resolution = shownPanel(page).getByTestId('resolution');
  const current = (await resolution.getByRole('button').first().textContent())?.trim() ?? '';
  const [oldWidth, oldHeight] = current.split('×').map(Number);
  const size = `${width}×${height}`;
  await resolution.getByRole('button', { name: current }).click();
  if (oldWidth === height && oldHeight === width) {
    await resolution.getByRole('menuitem', { name: `Rotate (${size})` }).click();
  } else if (COMMON.includes(size)) {
    await resolution.getByRole('menuitemcheckbox', { name: size, exact: true }).click();
  } else {
    await resolution.getByRole('menuitem', { name: 'Custom…' }).click();
    await dialog(page).getByLabel('Width').fill(String(width));
    await dialog(page).getByLabel('Height').fill(String(height));
    await dialog(page).getByRole('button', { name: 'OK' }).click();
  }
}

for (const workflow of workflows) {
  test(`workflow ${workflow.name}: the saved project is upstream's`, async ({ page }) => {
    await start(page);
    await menu(page, 'File', 'Open Example', workflow.example);
    await expect(page.getByTestId('project-file')).toContainText('project.json');
    await page.locator('[data-testid^="tab-page-"]').first().click();
    for (const step of workflow.steps) {
      if (step.addPage) {
        const count = await page.getByTestId('page').count();
        await menu(page, 'Project', 'Add Page');
        await expect(page.getByTestId('page')).toHaveCount(count + 1);
        continue;
      }
      if (step.initialPage) {
        await pageAction(page, step.initialPage, 'Set Initial Page');
        await expect(page.getByTestId('page').first()).toHaveText(step.initialPage);
        continue;
      }
      if (step.deletePage) {
        await pageAction(page, step.deletePage, 'Delete Page');
        await expect(page.getByRole('tab', { name: step.deletePage, exact: true })).toHaveCount(0);
        continue;
      }
      const [width, height] = step.resolution ?? [0, 0];
      await page.locator('[data-testid^="tab-page-"]').first().click();
      await chooseResolution(page, width, height);
      const d = dialog(page);
      await expect(d.getByRole('heading', { name: 'Change Resolution' })).toBeVisible();
      if (workflow.name.includes('unlinks-board')) {
        await expect(d).toContainText('it will be unlinked and the simulator selected');
      }
      await d.getByRole('radio', { name: MODES[step.mode ?? 'adapt'] }).check();
      await d.getByRole('button', { name: 'Apply' }).click();
      await expect(shownPanel(page).getByTestId('resolution')).toContainText(`${width}×${height}`);
    }
    // an example is read-only: Save goes to Save As, into the workspace
    await menu(page, 'File', 'Save');
    await expect(dialog(page).getByRole('heading', { name: 'Save Project' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('project-file')).toContainText('Workspace:');
    const text = await page.evaluate(async () => {
      const studio = window.lmsStudio.studio;
      const location = studio?.session.location;
      const data = location ? await studio?.stores.get(location.store)?.read(location.path) : null;
      return data ? new TextDecoder().decode(data) : '';
    });
    const saved = JSON.parse(text) as { projectId: string; pages: { id: string }[] };
    saved.projectId = '<normalised>';
    // the ids of the pages a step created: uuids, as in scripts/workflows.py
    const example = JSON.parse(
      readFileSync(
        new URL(`../../upstream/examples/${workflow.example}/project.json`, import.meta.url),
        'utf-8',
      ),
    ) as { pages: { id: string }[] };
    const original = new Set(example.pages.map((item) => item.id));
    let normalised = JSON.stringify(saved, null, 2) + '\n';
    saved.pages
      .filter((item) => !original.has(item.id))
      .forEach((item, index) => {
        normalised = normalised.replaceAll(item.id, `<new page ${index + 1}>`);
      });
    const expected = readFileSync(new URL(`${workflow.name}.json`, WORKFLOWS), 'utf-8');
    expect(normalised).toBe(expected);
  });
}

/** A point of the page, in its own pixels, on the screen: the canvas has 40 pixels around it. */
async function toScreen(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await shownPanel(page).locator('.stage').boundingBox();
  const zoom = await page.evaluate(() => {
    const studio = window.lmsStudio.studio;
    const id = studio?.currentPage();
    return id ? (studio?.designer?.view(id).zoom ?? 1) : 1;
  });
  if (!box) throw new Error('no canvas');
  return [box.x + (40 + x) * zoom, box.y + (40 + y) * zoom];
}

async function clickAt(page: Page, x: number, y: number, ctrl = false) {
  const [left, top] = await toScreen(page, x, y);
  if (ctrl) await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(left, top);
  if (ctrl) await page.keyboard.up('ControlOrMeta');
}

async function dragOn(page: Page, from: [number, number], to: [number, number]) {
  const start = await toScreen(page, ...from);
  const end = await toScreen(page, ...to);
  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(...end, { steps: 5 });
  await page.mouse.up();
}

const selectedOnCanvas = (page: Page) =>
  shownPanel(page)
    .locator('g[data-widget][aria-selected="true"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-widget')));

test('the canvas selects: a click, Ctrl and a click, the band, Select All, the empty page', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await page.getByRole('tab', { name: 'Menu', exact: true }).click();
  await shownFrame(page);
  await menu(page, 'View', 'Fit to Window'); // the whole page in view
  await clickAt(page, 240, 318); // btn_play, 120,286 240×64
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['btn_play']);
  await expect(page.getByTestId('properties-selection')).toHaveText('btn_play — button');
  await expect(shownPanel(page).locator('rect.handle')).toHaveCount(8);
  await clickAt(page, 240, 400, true); // btn_options
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['btn_play', 'btn_options']);
  // outside the page: nothing
  await clickAt(page, -6, -6);
  await expect.poll(() => selectedOnCanvas(page)).toEqual([]);
  await expect(page.getByText('No selection')).toBeVisible();
  // a band from outside the page across btn_play touches it and the background
  await dragOn(page, [-6, 270], [300, 300]);
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['menu_bg', 'btn_play']);
  // Select All: the widgets of the page, not its components
  await shownPanel(page).locator('.scroller').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(async () => (await selectedOnCanvas(page)).length).toBe(9);
  await expect(shownPanel(page).locator('rect.handle')).toHaveCount(72);
  // a double click opens the widget's handler in the Code tab
  await page.mouse.dblclick(...(await toScreen(page, 240, 318)));
  await expect(page.getByTestId('tab-code')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('code-select').locator('option:checked')).toHaveText(
    'btn_play_clicked',
  );
});

test('the project tree: pages with their widgets, the canvas follows it, components and modules', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await expect(page.getByTestId('page')).toHaveText(['Menu', 'Game', 'Options', 'Solved']);
  await expect(page.getByTestId('tree-widget').first()).toHaveText('beeper — buzzer');
  await page.getByTestId('tree-widget').filter({ hasText: 'board — panel' }).click();
  await expect(page.getByRole('tab', { name: 'Game', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['board']);
  // a page shows its canvas; the keyboard moves through the tree
  await page.getByRole('treeitem', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Options', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('tree-widget').filter({ hasText: 'opt_bg — panel' })).toBeFocused();
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['opt_bg']);
  // a component goes to Properties; the Components strip lists them
  await page.getByTestId('tree-widget').filter({ hasText: 'tick — timer' }).click();
  await expect(page.getByTestId('properties-selection')).toHaveText('tick — timer');
  await page.getByTestId('bottom-components').click();
  await expect(page.getByTestId('component')).toHaveText(['beeper', 'tick']);
  await expect(page.getByTestId('component').last()).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('component').first().click();
  await expect(page.getByTestId('properties-selection')).toHaveText('beeper — buzzer');
  // a double click on a widget of the tree opens its handler
  await page.getByTestId('tree-widget').filter({ hasText: 'btn_quit — button' }).dblclick();
  await expect(page.getByTestId('code-select').locator('option:checked')).toHaveText(
    'btn_quit_clicked',
  );
  // the last page cannot be deleted: the error goes to Output and Errors
  await menu(page, 'File', 'New');
  await page.getByTestId('page').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Page', exact: true }).click();
  await expect(page.getByTestId('errors')).toContainText('The last page cannot be deleted');
});
