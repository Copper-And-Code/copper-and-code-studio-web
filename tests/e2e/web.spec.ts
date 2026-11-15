// Phase 7 gate: the web version of a game, downloaded as a zip, unpacked and served by a static
// server, runs the game in all 3 engines; its files are those of upstream's build/web.py for the
// same project (tests/fixtures/web/files.json, from scripts/web-files.py on the host). The
// IDE's own preview opens it too, and a program without pages runs in the browser.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { expect, test } from './fixtures.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// the preview of a web version is served by its own service worker
test.use({ serviceWorkers: 'allow' });
const expected = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/web/files.json'), 'utf8'),
) as Record<string, { folder: string; files: string[] }>;

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

/** A static server for a folder, as any static host. */
async function serve(folder: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    let file = join(folder, path);
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
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
  return { server, url: `http://127.0.0.1:${port}/` };
}

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

/** The game's page started its game: main.main() runs, nothing failed. */
async function expectRunning(page: Page, flag: 'lms' | 'program' = 'lms') {
  if (flag === 'lms') {
    await page.waitForFunction(
      () => (window as unknown as { lms?: { running?: boolean } }).lms?.running === true,
      undefined,
      { timeout: 60_000 },
    );
  } else {
    await expect(page.locator('#status')).toHaveText(
      'Type on the keyboard; on a phone, touch the screen first.',
      { timeout: 60_000 },
    );
  }
  await page.waitForTimeout(2000); // a game that fails, fails at once
  await expect(page.locator('#status')).not.toHaveClass(/failed/);
}

/** Run → Open in Browser on an example: saved into the workspace first, then the dialog. */
async function buildExample(page: Page, example: string) {
  await menu(page, 'File', 'Open Example', example);
  await menu(page, 'Run', 'Open in Browser');
  await expect(dialog(page).getByRole('heading', { name: 'Save Project' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Web Version' })).toBeVisible({
    timeout: 120_000,
  });
}

test('the zip of a game, served by a static server, runs it, with upstream files', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await start(page);
  await buildExample(page, 'snake');
  const downloading = page.waitForEvent('download');
  await dialog(page).getByTestId('web-zip').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Snake-web.zip');
  const zip = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const names = Object.keys(zip).filter((name) => !name.endsWith('/'));
  expect(names.every((name) => name.startsWith('Snake-web/'))).toBe(true);
  expect(names.map((name) => name.slice('Snake-web/'.length)).sort()).toEqual(
    expected.snake?.files,
  );
  // unpacked and served, in a page of its own
  const folder = mkdtempSync(join(tmpdir(), 'lms-web-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    for (const name of names) {
      const target = join(folder, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, zip[name] as Uint8Array);
    }
    const { server, url } = await serve(join(folder, 'Snake-web'));
    try {
      const game = await context.newPage();
      await game.goto(url);
      await expectRunning(game);
      await game.close();
    } finally {
      server.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

async function openPreview(page: Page, context: BrowserContext): Promise<Page> {
  const link = dialog(page).getByTestId('web-open');
  await expect(link).toBeVisible();
  const opening = context.waitForEvent('page');
  await link.click();
  const game = await opening;
  await game.waitForLoadState();
  return game;
}

test('Open in Browser shows the game in a new tab of the IDE', async ({ page, context }) => {
  test.setTimeout(240_000);
  await start(page);
  await buildExample(page, 'fifteen');
  const game = await openPreview(page, context);
  expect(new URL(game.url()).pathname).toMatch(/\/preview\/Fifteen-web-[0-9a-z]+\/index\.html$/);
  await expectRunning(game);
  await expect(page.getByTestId('output')).toContainText(
    'Web version in Fifteen-web: to publish it, copy the folder to a static host.',
  );
});

test('Run in the Browser: a program without pages, its folder and the runtime', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await start(page);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await dialog(page).locator('#place').selectOption('examples');
  await dialog(page).getByRole('option', { name: '📁 shell' }).click();
  await dialog(page).getByRole('button', { name: 'Choose', exact: true }).click();
  await page
    .getByTestId('files-tree')
    .getByRole('treeitem', { name: 'shell.py' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Run in the Browser' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Web Version' })).toBeVisible({
    timeout: 120_000,
  });
  const game = await openPreview(page, context);
  await expectRunning(game, 'program');
});
