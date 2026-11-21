// The rename of 0.8.0 moved the site from OLD_BASE to BASE on the same origin: a user's
// settings (localStorage) and workspace (the private file system) written under the old address
// are read under the new one. An app installed from the old address must be installed again.
import type { Page } from '@playwright/test';
import { BASE, OLD_BASE } from '../../scripts/site.mjs';
import { expect, test } from './fixtures.ts';

async function start(page: Page) {
  await page.goto(BASE);
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

test('settings and workspace written under the old address are read under the new one', async ({
  page,
}) => {
  // any page of the old path: the origin is what counts, the site is no longer there
  await page.goto(`${OLD_BASE}missing.html`);
  expect(new URL(page.url()).pathname).toBe(`${OLD_BASE}missing.html`);
  await page.evaluate(async () => {
    localStorage.setItem('lms.language', JSON.stringify('it'));
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('workspace', { create: true });
    const file = await folder.getFileHandle('before-the-rename.txt', { create: true });
    const writable = await file.createWritable();
    await writable.write('written under the old address');
    await writable.close();
  });

  await start(page);
  await expect(
    page.getByRole('menubar').getByRole('menuitem', { name: 'Impostazioni', exact: true }),
  ).toBeVisible();
  const text = await page.evaluate(async () => {
    const data = await window.lmsStudio.studio?.stores
      .get('workspace')
      ?.read('before-the-rename.txt');
    return data ? new TextDecoder().decode(data) : null;
  });
  expect(text).toBe('written under the old address');
});
