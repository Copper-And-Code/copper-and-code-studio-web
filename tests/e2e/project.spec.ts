// Phase 2 gate: open an example, change it, save it in the workspace, reload the page and find
// the change; export a folder as a zip and import it again, with the same bytes.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

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

async function chooseFolder(page: Page, folder: string, create = false) {
  const d = dialog(page);
  if (create) {
    await d.getByRole('button', { name: 'New Folder' }).click();
    await d.locator('#folder-name').fill(folder);
    await d.locator('#folder-name').press('Enter');
  } else {
    await d.getByRole('option', { name: `📁 ${folder}` }).click();
  }
  await expect(d.locator('.crumbs')).toContainText(folder);
}

async function workspaceFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (path) => {
    const data = await window.lmsStudio.studio?.stores.get('workspace')?.read(path);
    return data ? new TextDecoder().decode(data) : null;
  }, path);
}

test('an example changed, saved in the workspace, is still changed after a reload', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'demo');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: demo.json');
  await expect(page).toHaveTitle('demo.json — LVGL MPY Studio');

  // the value: the name of the first page, renamed as on the desktop
  await page.getByTestId('page').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename Page' }).click();
  await dialog(page).locator('#text').fill('Welcome Home');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('page').first()).toHaveText('Welcome Home');
  await expect(page).toHaveTitle('*demo.json — LVGL MPY Studio');

  // Save on an example asks where: the workspace, in a new folder
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dialog(page).getByRole('heading', { name: 'Save Project' })).toBeVisible();
  await expect(dialog(page).locator('#place')).toHaveValue('workspace');
  await chooseFolder(page, 'mine', true);
  await expect(dialog(page).locator('#name')).toHaveValue('demo.json');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveTitle('demo.json — LVGL MPY Studio');
  await expect(page.getByTestId('project-file')).toHaveText('Workspace: mine/demo.json');

  await page.reload();
  await start(page);
  await expect(page.getByTestId('project-file')).toHaveText('not saved');
  await menu(page, 'File', 'Recent Files', 'Workspace: mine/demo.json');
  await expect(page.getByTestId('page').first()).toHaveText('Welcome Home');
  await expect(page).toHaveTitle('demo.json — LVGL MPY Studio');
  expect(await workspaceFile(page, 'mine/demo.json')).toContain('"Welcome Home"');
});

test('a folder exported as a zip and imported again has the same bytes', async ({ page }) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'snake');
  await menu(page, 'File', 'Save As…');
  await chooseFolder(page, 'zipped', true);
  await expect(dialog(page).locator('#name')).toHaveValue('project.json');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('project-file')).toHaveText('Workspace: zipped/project.json');

  // export the folder
  await menu(page, 'File', 'Export Folder as Zip…');
  await chooseFolder(page, 'zipped');
  const exported = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Export' }).click();
  const zipPath = await (await exported).path();
  const zip = readFileSync(zipPath);
  expect((await exported).suggestedFilename()).toBe('zipped.zip');

  // import it into another folder
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'File', 'Import into the Workspace…');
  await (await chooser).setFiles({ name: 'zipped.zip', mimeType: 'application/zip', buffer: zip });
  await chooseFolder(page, 'again', true);
  await dialog(page).getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('footer')).toContainText('Imported 1 files');

  const original = await workspaceFile(page, 'zipped/project.json');
  expect(original).not.toBeNull();
  expect(await workspaceFile(page, 'again/project.json')).toBe(original);

  // and the zip of the imported folder is the same zip, byte for byte
  await menu(page, 'File', 'Export Folder as Zip…');
  await chooseFolder(page, 'again');
  const again = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Export' }).click();
  expect(readFileSync(await (await again).path()).equals(zip)).toBe(true);
});

test('unsaved changes are asked about before a new project', async ({ page }) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'demo');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: demo.json');
  await page.getByTestId('page').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename Page' }).click();
  await dialog(page).locator('#text').fill('Changed');
  await dialog(page).getByRole('button', { name: 'OK' }).click();

  await menu(page, 'File', 'New');
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('page').first()).toHaveText('Changed');

  await menu(page, 'File', 'New');
  await dialog(page).getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('project-file')).toHaveText('not saved');
  await expect(page.getByTestId('project-name')).not.toHaveText('demo');
});

test('undo and redo follow the document', async ({ page }) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'demo');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: demo.json');
  const name = (await page.getByTestId('page').first().textContent())?.trim() ?? '';
  await page.getByTestId('page').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename Page' }).click();
  await dialog(page).locator('#text').fill('Renamed');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('page').first()).toHaveText(name);
  await expect(page).toHaveTitle('demo.json — LVGL MPY Studio');
  await menu(page, 'Edit', 'Redo');
  await expect(page.getByTestId('page').first()).toHaveText('Renamed');
});
