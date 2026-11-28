import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { upstreamInfo } from '../../scripts/upstream-info.mjs';
import { upstreamLabel } from '../../src/upstream.ts';

describe('upstreamLabel', () => {
  it('shows the tag when the submodule is on one', () => {
    expect(
      upstreamLabel({ tag: 'v0.7.0', commit: 'a45a85f00f4e', version: '0.7.0', website: '' }),
    ).toBe('v0.7.0');
  });

  it('says the commit is untagged otherwise', () => {
    expect(
      upstreamLabel({ tag: null, commit: 'a45a85f00f4e', version: '0.7.0', website: '' }),
    ).toBe('0.7.0 (untagged a45a85f00f4e)');
  });
});

describe('upstreamInfo', () => {
  it('reads the version of the upstream package', () => {
    const init = readFileSync('upstream/copper_and_code_studio/__init__.py', 'utf8');
    const info = upstreamInfo();
    expect(init).toContain(`__version__ = "${info.version}"`);
    expect(info.commit).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reads the address of the project website, for Help and the About box', () => {
    expect(upstreamInfo().website).toMatch(/^https:\/\/[^ ]+\/$/);
  });

  it('names a tag that matches the version, when there is one', () => {
    const info = upstreamInfo();
    if (info.tag !== null) expect(info.tag).toBe(`v${info.version}`);
  });
});
