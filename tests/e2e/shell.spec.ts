import { expect, test } from './fixtures.ts';
import { upstreamInfo } from '../../scripts/upstream-info.mjs';
import { upstreamLabel } from '../../src/upstream.ts';

test('the empty shell shows the upstream release in the About box', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/ — Copper and Code Studio$/);
  await expect(page.getByRole('menubar', { name: 'Main menu' })).toBeVisible();

  await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About Copper and Code Studio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copper and Code Studio Web' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('upstream-tag')).toHaveText(upstreamLabel(upstreamInfo()));

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
