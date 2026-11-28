import { expect, test } from './fixtures.ts';
import { REPOSITORY, SITE } from '../../scripts/site.mjs';
import { upstreamInfo } from '../../scripts/upstream-info.mjs';
import { upstreamLabel } from '../../src/upstream.ts';

test('the empty shell shows the upstream release in the About box', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/ — Copper and Code Studio$/);
  await expect(page.getByRole('menubar', { name: 'Main menu' })).toBeVisible();
  // what a search engine or the preview of a shared link reads: the page is empty without its script
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /MicroPython and LVGL, in the browser/,
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', SITE);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    `${SITE}icons/icon-512.png`,
  );

  await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About Copper and Code Studio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copper and Code Studio Web' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('upstream-tag')).toHaveText(upstreamLabel(upstreamInfo()));
  // where the documentation, the source and the licences are: the site serves minified code
  await expect(dialog.getByTestId('about-website')).toHaveAttribute('href', upstreamInfo().website);
  await expect(dialog.getByTestId('about-source')).toHaveAttribute('href', REPOSITORY);
  // the credits and the copyright, as the desktop's About
  await expect(dialog.getByTestId('about-credits')).toContainText(
    /Credits:\s+designed and directed by .+, developed with AI agents/,
  );
  await expect(dialog).toContainText(/Copyright \(c\) 2026 \S/);
  await expect(dialog).toContainText('License: GPL-3.0-or-later');
  await expect(dialog).toContainText('absolutely no warranty');
  for (const [link, text] of [
    ['about-licence', 'GNU GENERAL PUBLIC LICENSE'],
    ['about-third-party', 'third-party software in this site'],
  ] as const) {
    const href = await dialog.getByTestId(link).getAttribute('href');
    const served = await page.request.get(new URL(href ?? '', page.url()).href);
    expect(served.ok(), link).toBe(true);
    expect(await served.text(), link).toContain(text);
  }

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('Help has the online documentation, as the desktop', async ({ page }) => {
  await page.goto('./');
  // not followed: the test only looks at what the item would open
  await page.evaluate(() => {
    window.open = (...args: unknown[]) => {
      (window as unknown as { opened: unknown[] }).opened = args;
      return null;
    };
  });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Online Documentation' }).click();
  expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([
    upstreamInfo().website,
    '_blank',
    'noopener',
  ]);
});

test('behind a modal dialog the shortcuts of the window do nothing', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About Copper and Code Studio' }).click();
  const about = page.getByRole('dialog', { name: 'Copper and Code Studio Web' });
  await expect(about).toBeVisible();
  // F5 would start the new project (and ask where to save it first), Ctrl+O ask for a file
  await page.keyboard.press('F5');
  await page.keyboard.press('ControlOrMeta+o');
  await page.waitForTimeout(500);
  await expect(page.locator('lms-dialogs dialog[open]')).toHaveCount(0);
  await expect(page.getByTestId('sim-frame')).toHaveCount(0);
  // the page was not loaded again either: F5 is still the IDE's, not the browser's
  await expect(about).toBeVisible();
  await about.getByRole('button', { name: 'Close' }).click();
  // with the dialog closed they work as before
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('lms-dialogs dialog[open]')).toHaveCount(1);
});
