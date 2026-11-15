// Phase 9: Settings → Language switches the IDE to Italian at once, as the desktop's
// ui/language.py does, upstream's own texts included (the Toolbox comes from Python); the choice
// is kept, and a browser in Italian starts in Italian.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

async function start(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

test('Settings → Language: Italian at once, and kept', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('toolbox')).toContainText('Basic');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Italiano' }).click();
  await expect(
    page.getByRole('menubar').getByRole('menuitem', { name: 'Impostazioni', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menubar').getByRole('menuitem', { name: 'Progetto', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  // the Toolbox's categories are upstream's tr() in Python
  await expect(page.getByTestId('toolbox')).toContainText('Base');
  await expect(page.getByTestId('toolbox')).not.toContainText('Basic');

  await start(page);
  await expect(
    page.getByRole('menubar').getByRole('menuitem', { name: 'Impostazioni', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('toolbox')).toContainText('Base');
  await page
    .getByRole('menubar')
    .getByRole('menuitem', { name: 'Impostazioni', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Lingua', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Italiano' })).toBeChecked();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();
  await expect(
    page.getByRole('menubar').getByRole('menuitem', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('toolbox')).toContainText('Basic');
});

test.describe('a browser in Italian', () => {
  test.use({ locale: 'it-IT' });

  test('starts in Italian', async ({ page }) => {
    await start(page);
    await expect(
      page.getByRole('menubar').getByRole('menuitem', { name: 'Impostazioni', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('python-status')).toContainText('pronto in');
  });
});
