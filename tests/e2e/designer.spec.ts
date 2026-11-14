// Phase 5, sub-gate 1: the canvas. Every page of every example, as the designer's Real LVGL
// Preview draws it, is the desktop runtime's frame of the page, pixel for pixel
// (tests/fixtures/previews, from scripts/previews.py; threshold 0, upstream's visual tests'
// default). Zoom, Fit to Window and the resolution work as on the desktop.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
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
  /** A page whose preview must be the native runtime's frame of the saved project. */
  frame?: string;
  steps: {
    resolution?: [number, number];
    mode?: 'adapt' | 'stretch' | 'keep';
    addPage?: boolean;
    initialPage?: string;
    deletePage?: string;
    select?: string[];
    set?: [string, string];
    event?: string;
    page?: string;
    add?: [string, number, number];
    drop?: [string, number, number];
    move?: [number, number];
    resize?: Record<string, [number, number]>;
    copy?: boolean;
    cut?: boolean;
    paste?: boolean;
    duplicate?: boolean;
    delete?: boolean;
    align?: string;
    distribute?: string;
    front?: boolean;
    back?: boolean;
    adaptPage?: string;
    code?: [string, string | null, string];
    projectSettings?: [string, string];
    file?: [string, string];
  }[];
}

/** The widgets selected as a person would: the first in the tree, the others with Ctrl on the canvas. */
async function selectWidgets(page: Page, names: string[]) {
  const [first, ...others] = names;
  await page.getByRole('treeitem', { name: new RegExp(`^${first} — `) }).click();
  if (others.length) await menu(page, 'View', 'Fit to Window');
  for (const name of others) {
    const center = await page.evaluate((name) => {
      const studio = window.lmsStudio.studio;
      const id = studio?.currentPage() ?? '';
      const widget = studio?.designer?.pages.get(id)?.widgets.find((w) => w.name === name);
      const props = (widget?.props ?? {}) as Record<string, number>;
      return [(props.x ?? 0) + (props.width ?? 0) / 2, (props.y ?? 0) + (props.height ?? 0) / 2];
    }, name);
    await clickAt(page, center[0] ?? 0, center[1] ?? 0, true);
  }
  await expect
    .poll(() => page.evaluate(() => window.lmsStudio.studio?.designer?.propertiesView.names))
    .toEqual(names);
}

/** A value typed into the Properties panel, or a box ticked. */
async function setProperty(page: Page, name: string, text: string) {
  await page.getByTestId('properties-tab-properties').click();
  const input = page.getByTestId('properties').locator(`[data-property="${name}"]`);
  if ((await input.getAttribute('type')) === 'checkbox') await input.setChecked(text === 'true');
  else {
    await input.fill(text);
    await input.press('Enter');
  }
  await expect
    .poll(() =>
      page.evaluate((name) => {
        const view = window.lmsStudio.studio?.designer?.propertiesView;
        const row = view?.categories.flatMap((c) => c.rows).find((r) => r.name === name);
        return row?.value;
      }, name),
    )
    .toBe(text);
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
    test.setTimeout(60_000); // the longest replay many steps of the canvas
    await start(page);
    await menu(page, 'File', 'Open Example', workflow.example);
    await expect(page.getByTestId('project-file')).toContainText('project.json');
    // the tree is filled after the project opens: every page of the example in it first
    const pages = (
      JSON.parse(
        readFileSync(
          new URL(`../../upstream/examples/${workflow.example}/project.json`, import.meta.url),
          'utf-8',
        ),
      ) as { pages: unknown[] }
    ).pages.length;
    await expect(page.getByTestId('page')).toHaveCount(pages);
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
      if (step.page) {
        await page.getByRole('tab', { name: step.page, exact: true }).click();
        await menu(page, 'View', 'Fit to Window');
        continue;
      }
      if (await canvasStep(page, step)) continue;
      if (step.select) {
        if (step.select.length) await selectWidgets(page, step.select);
        else await clickAt(page, -6, -6);
        continue;
      }
      if (step.set) {
        await setProperty(page, ...step.set);
        continue;
      }
      if (step.file) {
        // the … button of the property, and the file chosen in the browser's own dialog
        const [name, path] = step.file;
        await page.getByTestId('properties-tab-properties').click();
        const chooser = page.waitForEvent('filechooser');
        await page.getByTestId('properties').locator(`[data-choose="${name}"]`).click();
        const before = await page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText);
        await (await chooser).setFiles(new URL(`../fixtures/${path}`, import.meta.url).pathname);
        await expect
          .poll(() => page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText))
          .toBe(`Change ${name}`);
        void before;
        continue;
      }
      if (step.event) {
        await page.getByTestId('properties-tab-events').click();
        await page.getByTestId('events').locator(`[data-event="${step.event}"]`).dblclick();
        await expect(page.getByTestId('tab-code')).toHaveAttribute('aria-selected', 'true');
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
    const saved = JSON.parse(text) as { projectId: string };
    saved.projectId = '<normalised>';
    // every id a step created: uuids, numbered by their order in the file, as scripts/workflows.py
    const ids = (source: string) =>
      [...source.matchAll(/"id": "([0-9a-f]{32})"/g)].map((m) => m[1]);
    const exampleText = readFileSync(
      new URL(`../../upstream/examples/${workflow.example}/project.json`, import.meta.url),
      'utf-8',
    );
    const original = new Set(ids(JSON.stringify(JSON.parse(exampleText), null, 2)));
    let normalised = (JSON.stringify(saved, null, 2) + '\n').replace(
      // a picture as its size, as scripts/workflows.py: Qt and the browser encode PNG differently
      /"data": "data:image\/png;base64,([A-Za-z0-9+/=]+)"/g,
      (_all, base64: string) => {
        const data = Buffer.from(base64, 'base64');
        return `"data": "<png ${data.readUInt32BE(16)}x${data.readUInt32BE(20)}>"`;
      },
    );
    const created = [...new Set(ids(normalised))].filter((id) => id && !original.has(id));
    created.forEach((id, index) => {
      normalised = normalised.replaceAll(id ?? '', `<new ${index + 1}>`);
    });
    const expected = readFileSync(new URL(`${workflow.name}.json`, WORKFLOWS), 'utf-8');
    expect(normalised).toBe(expected);
    if (workflow.frame) {
      // the page drawn with the font or the picture: the native runtime's frame, pixel for pixel
      await page.getByRole('tab', { name: workflow.frame, exact: true }).click();
      const frame = await shownFrame(page);
      const reference = readPng(new URL(`${workflow.name}.png`, WORKFLOWS).pathname);
      expect(differentPixels(reference.rgb, frame), `${workflow.name}: different pixels`).toBe(0);
    }
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

const nameField = (page: Page) => page.getByTestId('properties').locator('[data-property="Name"]');

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
  await expect(nameField(page)).toHaveValue('btn_play');
  await expect(shownPanel(page).locator('rect.handle')).toHaveCount(8);
  await clickAt(page, 240, 400, true); // btn_options
  await expect.poll(() => selectedOnCanvas(page)).toEqual(['btn_play', 'btn_options']);
  // outside the page: nothing
  await clickAt(page, -6, -6);
  await expect.poll(() => selectedOnCanvas(page)).toEqual([]);
  await expect(page.getByTestId('properties')).toHaveCount(0);
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
  await expect(page.getByTestId('code-signature')).toHaveText('def btn_play_clicked(e):');
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
  await expect(nameField(page)).toHaveValue('tick');
  await page.getByTestId('bottom-components').click();
  await expect(page.getByTestId('component')).toHaveText(['beeper', 'tick']);
  await expect(page.getByTestId('component').last()).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('component').first().click();
  await expect(nameField(page)).toHaveValue('beeper');
  // a double click on a widget of the tree opens its handler
  await page.getByTestId('tree-widget').filter({ hasText: 'btn_quit — button' }).dblclick();
  await expect(page.getByTestId('code-signature')).toHaveText('def btn_quit_clicked(e):');
  // the last page cannot be deleted: the error goes to Output and Errors
  await menu(page, 'File', 'New');
  await page.getByTestId('page').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Page', exact: true }).click();
  await expect(page.getByTestId('errors')).toContainText('The last page cannot be deleted');
});

test('the Properties panel: categories, the editors, a value refused, a name taken, undo', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await page.getByRole('treeitem', { name: 'menu_title — label' }).click();
  const table = page.getByTestId('properties');
  await expect(table.locator('tbody[data-category] tr.group')).toHaveText([
    'Identity',
    'Position',
    'Appearance',
  ]);
  await expect(table.locator('[data-property="x"]')).toHaveValue('60');
  await expect(table.locator('[data-property="textAlign"]')).toHaveAttribute(
    'list',
    'options-textAlign',
  );
  await expect(table.locator('[data-property="recolor"]')).toHaveAttribute('type', 'checkbox');
  // alphabetical: one list, by label
  await page.getByTestId('properties-order').selectOption('alphabetical');
  const labels = await table.locator('th.label').allTextContents();
  expect(labels).toEqual(
    [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  );
  await page.getByTestId('properties-order').selectOption('category');

  // a number goes to the project and to the canvas, as one undo step
  await setProperty(page, 'y', '200');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText)).toBe(
    'Change y',
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const studio = window.lmsStudio.studio;
        const page = studio?.designer?.pages.get(studio.currentPage() ?? '');
        return page?.widgets.find((w) => w.name === 'menu_title')?.props.y;
      }),
    )
    .toBe(200);
  // a name taken: the message, and the field shows the name again
  await nameField(page).fill('btn_play');
  await nameField(page).press('Enter');
  await expect(page.getByTestId('properties-error')).not.toBeEmpty();
  await expect(nameField(page)).toHaveValue('menu_title');
  // a name that is not one
  await nameField(page).fill('9 lives');
  await nameField(page).press('Enter');
  await expect(page.getByTestId('properties-error')).not.toBeEmpty();
  await expect(nameField(page)).toHaveValue('menu_title');
  // undo puts the value back
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(table.locator('[data-property="y"]')).toHaveValue('186');

  // two buttons: the name is empty, the values they share are shown, the others are empty
  await selectWidgets(page, ['btn_play', 'btn_options']);
  await expect(nameField(page)).toHaveValue('');
  await expect(table.locator('[data-property="x"]')).toHaveValue('120');
  await expect(table.locator('[data-property="y"]')).toHaveValue('');
  // Events are for one widget at a time
  await page.getByTestId('properties-tab-events').click();
  await expect(page.getByTestId('events')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'btn_play — button' }).click();
  await expect(page.getByTestId('events').locator('tr.bound')).toHaveText([
    /CLICKED[\s\S]*btn_play_clicked/,
  ]);
});

/** Waits until the project changed: the undo text of the step. */
async function changed(page: Page, before: number) {
  await expect
    .poll(() => page.evaluate(() => window.lmsStudio.studio?.designer?.revisionCount ?? 0))
    .toBeGreaterThan(before);
}

const revision = (page: Page) =>
  page.evaluate(() => window.lmsStudio.studio?.designer?.revisionCount ?? 0);

/** A step of the canvas as a person does it: the Toolbox, the keys, the handles, the menus. */
async function canvasStep(page: Page, step: Workflow['steps'][number]): Promise<boolean> {
  const before = await revision(page);
  const scroller = shownPanel(page).locator('.scroller');
  if (step.add) {
    const [type, x, y] = step.add;
    await page.getByTestId('toolbox').locator(`[data-type="${type}"]`).dblclick();
    await clickAt(page, x, y);
  } else if (step.drop) {
    const [type, x, y] = step.drop;
    const [left, top] = await toScreen(page, x, y);
    const box = await shownPanel(page).getByTestId('canvas').boundingBox();
    await page
      .getByTestId('toolbox')
      .locator(`[data-type="${type}"]`)
      .dragTo(shownPanel(page).getByTestId('canvas'), {
        targetPosition: { x: left - (box?.x ?? 0), y: top - (box?.y ?? 0) },
      });
  } else if (step.move) {
    await scroller.focus();
    const [dx, dy] = step.move;
    const key = dx > 0 ? 'ArrowRight' : dx < 0 ? 'ArrowLeft' : dy > 0 ? 'ArrowDown' : 'ArrowUp';
    const distance = Math.abs(dx || dy);
    await page.keyboard.press(distance === 10 ? `Shift+${key}` : key);
  } else if (step.resize) {
    // the bottom right handle, dragged to the new size
    const [name, size] = Object.entries(step.resize)[0] ?? [];
    const rect = await page.evaluate((name) => {
      const studio = window.lmsStudio.studio;
      const widget = studio?.designer?.pages
        .get(studio.currentPage() ?? '')
        ?.widgets.find((w) => w.name === name);
      return widget?.props as { x: number; y: number; width: number; height: number };
    }, name ?? '');
    const [width, height] = size ?? [0, 0];
    const start = await toScreen(page, rect.x + rect.width, rect.y + rect.height);
    const end = await toScreen(page, rect.x + width, rect.y + height);
    await page.mouse.move(...start);
    await page.mouse.down();
    await page.mouse.move(...end, { steps: 4 });
    await page.mouse.up();
  } else if (step.cut || step.copy || step.paste || step.duplicate) {
    await scroller.focus();
    const key = step.cut ? 'x' : step.copy ? 'c' : step.paste ? 'v' : 'd';
    await page.keyboard.press(`ControlOrMeta+${key}`);
    if (step.copy) return true;
  } else if (step.delete) {
    await scroller.focus();
    await page.keyboard.press('Delete');
  } else if (step.align) {
    const labels: Record<string, string> = {
      left: 'Align Left',
      center: 'Align Center',
      right: 'Align Right',
      top: 'Align Top',
      middle: 'Align Middle',
      bottom: 'Align Bottom',
    };
    await menu(page, 'Arrange', labels[step.align] ?? '');
  } else if (step.distribute) {
    await menu(
      page,
      'Arrange',
      step.distribute === 'horizontal' ? 'Distribute Horizontally' : 'Distribute Vertically',
    );
  } else if (step.front || step.back) {
    await scroller.focus();
    await page.keyboard.press(step.front ? 'ControlOrMeta+]' : 'ControlOrMeta+[');
  } else if (step.code) {
    // the Object, the Procedure, then the text typed into the editor
    const [object, event, text] = step.code;
    await page.getByTestId('tab-code').click();
    await page.getByTestId('code-object').selectOption(object);
    if (event) {
      await expect(page.getByTestId('code-procedure').locator('option')).not.toHaveCount(0);
      await page.getByTestId('code-procedure').selectOption({ label: event });
      await expect(page.getByTestId('code-signature')).toContainText(`_${event.toLowerCase()}(e):`);
    }
    const editor = page.locator('#panel-code .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
    await expect.poll(() => page.evaluate(() => window.lmsStudio.studio?.code.text())).toBe(text);
    await expect
      .poll(() => page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText))
      .toBe('Edit Code');
    return true;
  } else if (step.projectSettings) {
    const [profileId, mode] = step.projectSettings;
    const name = await page.evaluate(
      async (id) =>
        (
          (await window.lmsStudio.python.call('profiles_manager')) as {
            profiles: { id: string; name: string }[];
          }
        ).profiles.find((p) => p.id === id)?.name ?? '',
      profileId,
    );
    await menu(page, 'Project', 'Project Settings…');
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Project Settings' })).toBeVisible();
    await d.getByLabel('Board Profile').selectOption({ label: name });
    await expect(d.getByLabel('Width')).toBeDisabled();
    await expect(d.getByTestId('settings-info')).toContainText('Physical display');
    await d.getByRole('button', { name: 'Apply' }).click();
    await expect(d.getByRole('heading', { name: 'Change Resolution' })).toBeVisible();
    await d.getByRole('radio', { name: MODES[mode as 'adapt'] }).check();
    await d.getByRole('button', { name: 'Apply' }).click();
  } else if (step.adaptPage) {
    await page.getByRole('tab', { name: step.adaptPage, exact: true }).click();
    await menu(page, 'Arrange', 'Adapt Page to Resolution…');
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Adapt Page to Resolution' })).toBeVisible();
    await d.getByRole('radio', { name: MODES[step.mode ?? 'adapt'] }).check();
    await d.getByRole('button', { name: 'Apply' }).click();
  } else return false;
  await changed(page, before);
  return true;
}

test('a drag moves the widgets, the real frame follows, Ctrl+Z puts them back', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  await page.getByRole('tab', { name: 'Menu', exact: true }).click();
  await shownFrame(page);
  await menu(page, 'View', 'Fit to Window');
  await clickAt(page, 240, 318); // btn_play
  // whole pixels, as the browser reports them: the page moves by what they make at this zoom
  const start_ = (await toScreen(page, 240, 318)).map(Math.round) as [number, number];
  const end = (await toScreen(page, 240, 418)).map(Math.round) as [number, number];
  const zoom = await page.evaluate(() => {
    const studio = window.lmsStudio.studio;
    return studio?.designer?.view(studio.currentPage() ?? '').zoom ?? 1;
  });
  const moved = 286 + Math.round((end[1] - start_[1]) / zoom);
  await page.mouse.move(...start_);
  await page.mouse.down();
  await page.mouse.move(...end, { steps: 6 });
  // while dragging: not yet in the project, but drawn by the runtime where it is going
  const props = () =>
    page.evaluate(() => {
      const studio = window.lmsStudio.studio;
      const p = studio?.designer?.pages.get(studio.currentPage() ?? '');
      return p?.widgets.find((w) => w.name === 'btn_play')?.props.y;
    });
  expect(await props()).toBe(286);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const studio = window.lmsStudio.studio;
        const id = studio?.currentPage() ?? '';
        const key = studio?.designer?.pages.get(id)?.key;
        const preview = studio?.designer?.previews.get(id);
        return Boolean(preview?.pixels && preview.key !== key);
      }),
    )
    .toBe(true);
  await page.mouse.up();
  await expect.poll(props).toBe(moved);
  expect(await page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText)).toBe(
    'Change Geometry',
  );
  await shownPanel(page).locator('.scroller').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(props).toBe(286);
  const frame = await shownFrame(page);
  const expected = readPng(new URL('fifteen/Menu.png', FIXTURES).pathname);
  expect(differentPixels(expected.rgb, frame)).toBe(0);

  // the canvas's menu; Escape takes back a widget armed in the Toolbox
  await page.mouse.click(...start_, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByTestId('toolbox').locator('[data-type="slider"]').dblclick();
  await expect(page.getByTestId('armed')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('armed')).toHaveCount(0);

  // Delete on the Components strip
  await page.getByTestId('bottom-components').click();
  await page.getByTestId('component').first().click();
  await page.getByTestId('component').first().press('Delete');
  await expect(page.getByTestId('component')).toHaveText(['tick']);
});

const budgets = (
  JSON.parse(readFileSync(new URL('../fixtures/budget/index.json', import.meta.url), 'utf-8')) as {
    budgets: Record<string, { flash: number; flashByName: number; ram: number }>;
  }
).budgets;

test("the budget in the status bar: the flash is upstream's on every example, the RAM measured", async ({
  page,
}) => {
  test.setTimeout(30_000 + Object.keys(budgets).length * 20_000);
  await start(page);
  for (const [name, expected] of Object.entries(budgets)) {
    await menu(page, 'File', 'Open Example', name);
    await expect(page.getByTestId('project-file')).toContainText(`${name}/project.json`);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const studio = window.lmsStudio.studio;
            return studio?.budget?.budget ?? null;
          }),
        { timeout: 20_000 },
      )
      .toMatchObject({ flash: expected.flashByName });
    const measured = await page.evaluate(() => window.lmsStudio.studio?.budget?.budget?.ram ?? 0);
    expect(measured, `${name}: RAM`).toBeGreaterThan(0);
    await expect(page.getByTestId('budget')).toContainText('Flash ');
  }
});

test('the Code tab: Object and Procedure, a handler made by typing, an action, a completion', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'fifteen');
  // a double click on a widget without a handler: its object, at its default event, not made yet
  await page.getByRole('treeitem', { name: 'menu_title — label' }).dblclick();
  await expect(page.getByTestId('code-object').locator('option:checked')).toHaveText(
    'menu_title (label)',
  );
  await expect(page.getByTestId('code-signature')).toHaveText('def menu_title_clicked(e):');
  expect(
    await page.evaluate(() =>
      window.lmsStudio.studio?.code.state.handlers.some((h) => h.name === 'menu_title_clicked'),
    ),
  ).toBe(false);
  // the helper: the widget's own group is open; a double click inserts at the cursor mark
  const actions = page.getByTestId('actions');
  await actions.getByRole('treeitem', { name: 'Change text', exact: true }).first().dblclick();
  await expect(page.locator('#panel-code .cm-editor.cm-focused')).toHaveCount(1);
  await page.keyboard.type('Hi');
  await expect
    .poll(() => page.evaluate(() => window.lmsStudio.studio?.code.text()))
    .toBe('ui.menu_title.set_text("Hi")');
  // the first text made the handler, in bold in the Procedure list, an undo step
  await expect(page.getByTestId('code-procedure').locator('option.exists')).toContainText([
    'CLICKED',
  ]);
  await expect
    .poll(() => page.evaluate(() => window.lmsStudio.studio?.session.state?.undoText))
    .toBe('Edit Code');
  // completion: a widget's name gives ui.<name>., then its actions
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('btn_pl');
  await page.keyboard.press('ControlOrMeta+Space');
  await page.locator('.cm-tooltip-autocomplete li', { hasText: 'btn_play' }).first().click();
  await expect(
    page.locator('.cm-tooltip-autocomplete li', { hasText: 'add_flag — Hide' }),
  ).toBeVisible();
  // the search of the helper
  await page.getByRole('searchbox', { name: 'Search an object or action' }).fill('Open this page');
  await expect(actions.getByRole('treeitem', { name: 'Open this page' })).toHaveCount(4);
});

test('board profiles and blocks: managed, kept in the browser after a reload', async ({ page }) => {
  page.on('dialog', (question) => void question.accept());
  await start(page);
  // a custom profile, from the built-in one
  await menu(page, 'Device', 'Manage Board Profiles…');
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: 'Board Profile Manager' })).toBeVisible();
  await expect(d.getByTestId('profiles').locator('tbody tr')).toHaveCount(3);
  await d.getByRole('button', { name: 'Duplicate' }).click();
  await d.locator('#profile-name').fill('My board');
  await d.locator('#profile-name').press('Enter');
  await expect(d.getByTestId('profiles')).toContainText('My board');
  await d.getByRole('button', { name: 'Apply' }).click();
  await expect(d).toHaveCount(0);

  // a block from a folder of the workspace: upstream's own example block
  await page.evaluate(async () => {
    const workspace = window.lmsStudio.studio?.stores.get('workspace');
    const examples = window.lmsStudio.studio?.stores.get('examples');
    for (const name of ['block.json', 'board.py', 'simulator.py', 'LICENSE', 'README.md']) {
      const data = await examples?.read(`blocks/blinker/${name}`);
      if (data) await workspace?.write(`blinker/${name}`, data);
    }
  });
  await menu(page, 'Settings', 'Manage Blocks…');
  await expect(d.getByRole('heading', { name: 'Block Manager' })).toBeVisible();
  const standard = await d.getByTestId('blocks').locator('tbody tr').count();
  await d.getByRole('button', { name: 'Add from Folder…' }).click();
  await expect(d.getByRole('heading', { name: 'Choose the folder of the block' })).toBeVisible();
  await d.locator('#place').selectOption('workspace');
  await d.getByRole('option', { name: '📁 blinker' }).click();
  await expect(d.locator('.crumbs')).toContainText('blinker');
  await d.getByRole('button', { name: /^(Choose|Select|Open)/ }).click();
  await expect(d.getByRole('heading', { name: 'Block Manager' })).toBeVisible();
  await expect(d.getByTestId('blocks').locator('tbody tr')).toHaveCount(standard + 1);
  await d.getByRole('button', { name: 'Close' }).click();
  // the Toolbox has it: MainWindow._blocks_changed
  await expect(page.getByTestId('toolbox').locator('[data-type="blinker"]')).toHaveCount(1);

  // after a reload both are still there
  await page.reload();
  await start(page);
  await menu(page, 'Device', 'Manage Board Profiles…');
  await expect(d.getByTestId('profiles')).toContainText('My board');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await menu(page, 'Settings', 'Manage Blocks…');
  await expect(d.getByTestId('blocks').locator('tbody tr')).toHaveCount(standard + 1);
  // removed again
  await d.getByTestId('blocks').locator('tbody tr', { hasText: 'Installed by you' }).click();
  await d.getByRole('button', { name: 'Remove' }).click();
  await expect(d.getByTestId('blocks').locator('tbody tr')).toHaveCount(standard);
  await d.getByRole('button', { name: 'Close' }).click();
});

/** A PNG of one colour, as upstream's write_png writes it. */
function solidPng(width: number, height: number): Buffer {
  const crc = (data: Buffer) => {
    let value = ~0;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return ~value >>> 0;
  };
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(kind), body])));
    return Buffer.concat([head, Buffer.from(kind), body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a picture larger than the screen is made smaller, a file that is not one is refused, one Undo', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'weather');
  await page.getByRole('treeitem', { name: 'current_icon — image' }).click();
  const choose = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('properties').locator('[data-choose="src"]').click();
    await (await chooser).setFiles(file);
  };
  await choose({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') });
  await expect(page.getByTestId('properties-error')).toContainText(
    'notes.png is not a picture this program can read',
  );
  await choose({ name: 'wide photo.png', mimeType: 'image/png', buffer: solidPng(960, 240) });
  await expect(page.getByTestId('properties').locator('[data-property="src"]')).toHaveValue(
    'wide_photo.png',
  );
  const size = await page.evaluate(() => window.lmsStudio.python.call('image_sizes'));
  // 480×480 screen: 960×240 becomes 480×120, proportions kept
  expect(size).toContainEqual({ name: 'wide_photo.png', width: 480, height: 120 });
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('properties').locator('[data-property="src"]')).toHaveValue(
    'sunny.png',
  );
  expect(await page.evaluate(() => window.lmsStudio.python.call('image_sizes'))).not.toContainEqual(
    expect.objectContaining({ name: 'wide_photo.png' }),
  );
});
