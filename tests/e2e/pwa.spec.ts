// Phase 8 gate: with the network turned off after the first load, the IDE opens, a project opens,
// and the simulator runs. Also: a new deploy is offered as an update and taken on Reload, and
// Chromium finds the site installable.
import { createServer, type Server } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import type { Page } from '@playwright/test';
import { serviceWorker } from '../../scripts/sw-plugin.mjs';
import { expect, test } from './fixtures.ts';

test.use({ serviceWorkers: 'allow' });

const ROOT = join(import.meta.dirname, '..', '..');
const BASE = '/lvgl-mpy-studio-web/';

async function start(page: Page, url = './') {
  await page.goto(url);
  await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
  await page.evaluate(() => window.lmsStudio.started);
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

async function menu(page: Page, top: string, ...path: string[]) {
  await page.getByRole('button', { name: top, exact: true }).click();
  for (const item of path) await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** The site's worker controls the page and has every file of the deploy in its cache. */
async function cached(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 120_000,
  });
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith('lms-app-'));
    const name = names[0];
    return { names, files: name ? (await (await caches.open(name)).keys()).length : 0 };
  });
}

test('offline after the first load: the IDE opens, a project opens, the simulator runs', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await start(page);
  const cache = await cached(page);
  expect(cache.names).toHaveLength(1);
  expect(cache.files).toBeGreaterThan(50);

  await context.setOffline(true);
  await start(page);
  await menu(page, 'File', 'Open Example', 'snake');
  await expect(page.getByTestId('project-file')).toHaveText('Examples: snake/project.json');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('sim-status')).toContainText('RGB565', { timeout: 60_000 });
  await expect(page.getByTestId('sim-frame')).toBeVisible();
  await page.keyboard.press('Shift+F5');
  await expect(page.getByTestId('sim-status')).toHaveText('Simulator stopped');
  await context.setOffline(false);
});

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** A copy of the built site, served under its base path, that the test can deploy again. */
async function serveCopy(): Promise<{ folder: string; server: Server; url: string }> {
  const folder = mkdtempSync(join(tmpdir(), 'lms-pwa-'));
  cpSync(join(ROOT, 'dist'), folder, { recursive: true });
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    if (!path.startsWith(BASE)) {
      response.writeHead(404);
      response.end();
      return;
    }
    let file = join(folder, path.slice(BASE.length));
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { folder, server, url: `http://127.0.0.1:${port}${BASE}` };
}

test('a new deploy is offered as an update, and Reload takes it', async ({ page }) => {
  test.setTimeout(240_000);
  const site = await serveCopy();
  try {
    await start(page, site.url);
    const before = await cached(page);
    await expect(page.getByTestId('update')).toHaveCount(0);

    // the next deploy: one file more
    writeFileSync(join(site.folder, 'deployed.txt'), 'the next deploy\n');
    const { version } = serviceWorker(site.folder);
    expect(`lms-app-${version}`).not.toBe(before.names[0]);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    const update = page.getByTestId('update');
    await expect(update).toContainText('A new version of the IDE is ready.', { timeout: 60_000 });
    const reloaded = page.waitForEvent('load');
    await update.getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await page.waitForFunction(() => window.lmsStudio?.started !== undefined);
    await page.evaluate(() => window.lmsStudio.started);
    const after = await cached(page);
    expect(after.names).toEqual([`lms-app-${version}`]);
    expect(after.files).toBe(before.files + 1);
    await expect(page.getByTestId('update')).toHaveCount(0);
  } finally {
    site.server.close();
    rmSync(site.folder, { recursive: true, force: true });
  }
});

test('the site is installable', async ({ page, context, browserName }) => {
  const response = await page.request.get('manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as { icons: { src: string; sizes: string }[] };
  for (const icon of manifest.icons) {
    const png = await page.request.get(icon.src);
    expect(png.ok(), icon.src).toBe(true);
    const bytes = await png.body();
    const [width, height] = icon.sizes.split('x').map(Number);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], icon.src).toEqual([width, height]);
  }
  test.skip(browserName !== 'chromium', 'only Chromium tells why a page is not installable');
  await start(page);
  await cached(page);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: unknown[];
  };
  expect(installabilityErrors).toEqual([]);
});
