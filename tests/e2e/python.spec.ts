import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test } from './fixtures.ts';

const ROOT = join(import.meta.dirname, '../..');
const GOLDENS = join(ROOT, 'tests/fixtures/goldens');

test('Python starts in its worker and the About box names it', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('python-status')).toHaveText(/^Python 3\.\d+\.\d+ ready in /, {
    timeout: 60_000,
  });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: 'About LVGL MPY Studio' }).click();
  await expect(page.getByTestId('python-version')).toHaveText(/^3\.\d+\.\d+ \(Pyodide [\d.]+\)$/);
});

test('Python is ready in under 5 s with a warm cache', async ({ page }) => {
  const readyAt = async () => {
    await page.waitForFunction(() => window.lmsStudio?.pythonReadyAt !== undefined, null, {
      timeout: 60_000,
    });
    return Math.round(await page.evaluate(() => window.lmsStudio.pythonReadyAt ?? -1));
  };
  await page.goto('./');
  const cold = await readyAt();
  await page.reload();
  const warm = await readyAt();
  test.info().annotations.push({ type: 'ready', description: `cold ${cold} ms, warm ${warm} ms` });
  console.log(`${test.info().project.name}: Python ready cold ${cold} ms, warm ${warm} ms`);
  expect(warm).toBeLessThan(5_000);
});

function readTree(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(directory, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(directory);
  return files;
}

test('generation in the browser gives the same files as upstream on the host', async ({ page }) => {
  test.skip(!existsSync(join(GOLDENS, 'index.json')), 'no goldens: run `pnpm goldens` first');
  const index = JSON.parse(readFileSync(join(GOLDENS, 'index.json'), 'utf8')) as {
    projects: Record<string, { project: string; board: unknown }>;
  };
  await page.goto('./');
  for (const [name, entry] of Object.entries(index.projects)) {
    const text = readFileSync(join(ROOT, 'upstream', entry.project), 'utf8');
    const generated = await page.evaluate(
      async ([projectText, board]) => {
        const python = window.lmsStudio.python;
        await python.ready;
        return {
          py: (await python.generate(projectText)).files,
          board: board ? (await python.exportBoard(projectText)).files : null,
        };
      },
      [text, entry.board !== null] as const,
    );
    expect(generated.py, `${name}: MicroPython code`).toEqual(readTree(join(GOLDENS, name, 'py')));
    if (entry.board) {
      expect(generated.board, `${name}: board export`).toEqual(
        readTree(join(GOLDENS, name, 'board')),
      );
    }
  }
});
