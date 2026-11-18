// Phase 9: the IDE from the keyboard, with a screen reader's names, in the system's light or dark
// theme as the desktop's ui/theme.py. axe-core checks the ARIA, the names and the contrast.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

async function start(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

async function openWeather(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open Example', exact: true }).click();
  await page.getByRole('menuitem', { name: 'weather', exact: true }).click();
  await expect(page.getByTestId('project-file')).toHaveText('Examples: weather/project.json');
}

/** What the browser's focus is on, inside the shadow roots: its role and name. */
const focused = (page: Page) =>
  page.evaluate(() => {
    let element: Element | null = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return {
      role: element?.getAttribute('role') ?? element?.localName ?? '',
      name: (element?.getAttribute('aria-label') ?? element?.textContent ?? '').trim(),
    };
  });

for (const scheme of ['light', 'dark'] as const) {
  test(`no axe violations in the ${scheme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await start(page);
    await openWeather(page);
    for (const tab of ['main', 'Code']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      // the simulator's and the preview's frames draw LVGL, not the IDE
      const result = await new AxeBuilder({ page }).exclude('iframe').analyze();
      const found = result.violations.map((v) => `${tab}: ${v.id} (${v.nodes.length})`);
      expect(found).toEqual([]);
    }
  });
}

test('the code editor in the dark theme uses the desktop dark colours', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await start(page);
  await openWeather(page);
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  // CodeMirror highlights after it draws: wait for the keyword's own span
  const colours = async () =>
    page.evaluate(() => {
      const editor = document
        .querySelector('lms-app')
        ?.shadowRoot?.querySelector('lms-code-panel')
        ?.shadowRoot?.querySelector('lms-code-editor')?.shadowRoot;
      const keyword = [...(editor?.querySelectorAll('.cm-line span') ?? [])].find(
        (span) => span.textContent === 'import',
      );
      const gutter = editor?.querySelector('.cm-gutters');
      return {
        keyword: keyword ? getComputedStyle(keyword).color : '',
        gutter: gutter ? getComputedStyle(gutter).backgroundColor : '',
        page: getComputedStyle(document.body).backgroundColor,
      };
    });
  await expect.poll(async () => (await colours()).keyword).toBe('rgb(108, 182, 255)'); // ui/theme.py DARK keyword #6CB6FF
  expect((await colours()).gutter).toBe('rgb(23, 25, 29)');
  expect((await colours()).page).toBe('rgb(23, 25, 29)');
});

test('the menu bar from the keyboard: F10, arrows, Escape, Enter', async ({ page }) => {
  await start(page);
  await page.keyboard.press('F10');
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'File' });
  await page.keyboard.press('ArrowRight');
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'Edit' });
  await page.keyboard.press('End');
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'Help' });
  await page.keyboard.press('ArrowRight');
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'File' });
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  const first = await focused(page);
  expect(first.role).toBe('menuitem');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'File' })).toHaveCount(0);
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'File' });
  // Help → About from the keyboard
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Help' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'LVGL MPY Studio Web' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'LVGL MPY Studio Web' })).toHaveCount(0);
});

test('one stop of the menu bar in the Tab order, then the Toolbox', async ({ page }) => {
  await start(page);
  await page.keyboard.press('F10');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toEqual({ role: 'input', name: 'Search a widget' });
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).toEqual({ role: 'menuitem', name: 'File' });
});
