// Playwright's WebKit has no private file system (OPFS) in its default, throw-away profile;
// Safari has it, and so has WebKit with a profile on disk. Each WebKit test gets a new profile
// on disk, deleted afterwards; the other engines use the default context.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ browserName, playwright, baseURL, context }, use) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    const profile = mkdtempSync(join(tmpdir(), 'lms-webkit-'));
    const persistent = await playwright.webkit.launchPersistentContext(profile, {
      baseURL,
      acceptDownloads: true,
    });
    try {
      await use(persistent);
    } finally {
      await persistent.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

export { expect } from '@playwright/test';
