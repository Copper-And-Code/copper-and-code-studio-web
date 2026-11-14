import { expect, test } from '@playwright/test';
import { upstreamInfo } from '../../scripts/upstream-info.mjs';
import { upstreamLabel } from '../../src/upstream.ts';

test('the empty shell shows the upstream release in the About box', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle('LVGL MPY Studio Web');
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

  await page.getByRole('button', { name: 'About' }).click();
  const dialog = page.getByRole('dialog', { name: 'LVGL MPY Studio Web' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('upstream-tag')).toHaveText(upstreamLabel(upstreamInfo()));

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
