// Phase 4 gate: open the shell example's folder, edit shell.py, run it, and the change shows;
// mpy-cross's errors point to the right line. And the project's Code tab with its modules.
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
const transcript = (page: Page) =>
  page.evaluate(() => window.lmsStudio.studio?.run?.transcript ?? '');
const visibleEditor = (page: Page) =>
  page.locator('[role="tabpanel"]:not([hidden]) lms-code-editor .cm-content');

async function typeAtTop(page: Page, text: string) {
  const editor = visibleEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type(text);
}

test('the shell example: edited, copied into the workspace, run, and the change shows', async ({
  page,
}) => {
  await start(page);
  // Files → Open Folder…: the folder of the example
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  const d = dialog(page);
  await d.locator('#place').selectOption('examples');
  await d.getByRole('option', { name: '📁 shell' }).click();
  await d.getByRole('button', { name: 'Choose', exact: true }).click();
  await expect(page.getByTestId('files-folder')).toHaveText('Examples: shell');
  await page.getByRole('treeitem', { name: 'shell.py' }).dblclick();
  await expect(page.getByTestId('tab-file-1')).toHaveText('shell.py');

  await typeAtTop(page, 'print("edited in the browser")\n');
  await expect(page.getByTestId('tab-file-1')).toHaveText('shell.py *');
  await page.keyboard.press('ControlOrMeta+s');
  // an example cannot be written: its folder goes into the workspace first
  await expect(dialog(page).getByRole('heading', { name: 'Copy to the Workspace' })).toBeVisible();
  await expect(dialog(page).locator('#text')).toHaveValue('shell');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('tab-file-1')).toHaveText('shell.py');
  await expect(page.getByTestId('files-folder')).toHaveText('Workspace: shell');
  const copied = await page.evaluate(async () => {
    const workspace = window.lmsStudio.studio?.stores.get('workspace');
    const files = ['shell/shell.py', 'shell/ansiterm.py', 'shell/ansifont.py'];
    const data = await Promise.all(files.map((path) => workspace?.read(path)));
    return data.map((bytes) => (bytes ? new TextDecoder().decode(bytes).slice(0, 40) : null));
  });
  expect(copied[0]).toContain('print("edited in the browser")');
  expect(copied[1]).not.toBeNull();
  expect(copied[2]).not.toBeNull();

  // Run Program offers the file of the current tab
  await menu(page, 'Run', 'Run Program…');
  await expect(dialog(page).locator('#place')).toHaveValue('workspace');
  await expect(dialog(page).locator('#name')).toHaveValue('shell.py');
  await dialog(page).getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => transcript(page)).toContain('edited in the browser\nMicroPython shell');
  await expect.poll(() => transcript(page)).toContain('mpy@browser');
  await page.keyboard.press('Shift+F5');
  await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');
});

test("mpy-cross's errors point to the right line of a file", async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    const workspace = window.lmsStudio.studio?.stores.get('workspace');
    const code = 'import time\n\n\ndef tick():\n    return time.ticks_ms()\n';
    await workspace?.write('lines/main.py', new TextEncoder().encode(code));
    window.lmsStudio.studio?.setFilesFolder({ store: 'workspace', path: 'lines' });
  });
  await page.getByRole('treeitem', { name: 'main.py' }).dblclick();
  const editor = visibleEditor(page);
  await editor.click();
  // line 3 gets a broken definition
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('x = = 1');
  await expect(page.getByTestId('file-errors')).toHaveText('Line 3: SyntaxError: invalid syntax');
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .cm-error-line')).toHaveText(
    'x = = 1',
  );
  // fixed, the error goes
  await page.keyboard.press('Home');
  for (let count = 0; count < 4; count++) await page.keyboard.press('Delete');
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .cm-activeLine')).toHaveText('= 1');
  await page.keyboard.type('x ');
  await expect(page.getByTestId('file-errors')).toHaveCount(0);
});

test('the Code tab: a new module, its syntax error, Start stops on it, the Errors row opens it', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'snake');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: snake/project.json');
  await page.getByTestId('tab-code').click();
  await expect(page.getByTestId('code-select')).toHaveValue('module');

  await page.getByRole('button', { name: 'New Python Module…' }).click();
  await dialog(page).locator('#text').fill('helpers');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('module')).toHaveText('helpers.py');
  await expect(page.getByTestId('code-select').locator('option:checked')).toHaveText('helpers.py');
  expect(await page.evaluate(() => window.lmsStudio.studio?.code.text())).toBe(
    'import lvgl as lv\nimport ui\n\n\n',
  );

  const editor = visibleEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('value = = 1\n');
  await expect(page.getByTestId('code-errors')).toContainText('helpers.py, line');

  // F5 compiles first, as on the desktop: the error stops it and goes to Errors
  await page.keyboard.press('F5');
  // an example is saved first: Save As into the workspace
  await expect(dialog(page).getByRole('heading', { name: 'Save Project' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('bottom-errors')).toHaveText('Errors (1)');
  await expect(page.getByTestId('errors')).toContainText('helpers.py');
  await page.getByTestId('tab-designer').click();
  await page.getByTestId('errors').getByRole('button').first().click();
  await expect(page.getByTestId('tab-code')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('code-select').locator('option:checked')).toHaveText('helpers.py');

  // undo takes the module away again, step by step
  await page.getByTestId('tab-designer').focus();
  await menu(page, 'Edit', 'Undo');
  await menu(page, 'Edit', 'Undo');
  await expect(page.getByTestId('module')).toHaveCount(0);
});

test('a traceback in the simulator becomes a row of Errors that opens the line', async ({
  page,
}) => {
  await start(page);
  await menu(page, 'File', 'Open Example', 'tictactoe');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: tictactoe/project.json');
  await page.getByTestId('tab-code').click();
  await page.getByRole('button', { name: 'New Python Module…' }).click();
  await dialog(page).locator('#text').fill('boom');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('module')).toHaveText('boom.py');
  const editor = visibleEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('raise ValueError("boom")\n');
  await page.getByTestId('code-select').selectOption('module');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('import boom\n');

  await page.keyboard.press('F5');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('bottom-errors')).toHaveText(/Errors \(\d+\)/);
  const row = page
    .getByTestId('errors')
    .getByRole('button', { name: 'ValueError: boom', exact: true });
  await expect(row).toBeVisible();
  await page.keyboard.press('Shift+F5');
  await row.click();
  await expect(page.getByTestId('code-select').locator('option:checked')).toHaveText('boom.py');
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .cm-activeLine')).toHaveText(
    'raise ValueError("boom")',
  );
});

test('the Files panel creates, renames and deletes in the workspace', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.lmsStudio.studio?.stores.get('workspace')?.makeFolder('tools');
    window.lmsStudio.studio?.setFilesFolder({ store: 'workspace', path: 'tools' });
  });
  const tree = page.locator('lms-files-panel .tree');
  await tree.click({ button: 'right', position: { x: 20, y: 20 } });
  await page.getByRole('menuitem', { name: 'New File…' }).click();
  await expect(dialog(page).locator('#text')).toHaveValue('main.py');
  await dialog(page).locator('#text').fill('util.py');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('tab-file-1')).toHaveText('util.py');
  await expect(page.getByRole('treeitem', { name: 'util.py' })).toBeVisible();

  await page.getByRole('treeitem', { name: 'util.py' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await dialog(page).locator('#text').fill('helpers.py');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('treeitem', { name: 'helpers.py' })).toBeVisible();
  await expect(page.getByTestId('tab-file-1')).toHaveText('helpers.py');

  await page.getByRole('treeitem', { name: 'helpers.py' }).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await dialog(page).getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('treeitem', { name: 'helpers.py' })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.lmsStudio.studio?.stores.get('workspace')?.read('tools/helpers.py'),
    ),
  ).toBeNull();
});
