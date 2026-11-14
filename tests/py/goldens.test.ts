// Generation parity (PLAN.md phase 1 gate): upstream in Pyodide, reached through the web IDE's
// bundle and bridge, writes the same bytes as upstream on the host (scripts/goldens.py).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { installUpstream, type PythonCall } from '../../src/py/boot.ts';
import type { BoardExport, GeneratedProject } from '../../src/py/protocol.ts';
import { ROOT, startPyodide } from './pyodide-node.mjs';

const GOLDENS = join(ROOT, 'tests/fixtures/goldens');
const BUNDLE = join(ROOT, 'public/py');

interface GoldenIndex {
  upstreamVersion: string;
  projects: Record<
    string,
    { project: string; warnings: string[]; board: { profile: string; warnings: string[] } | null }
  >;
}

if (!existsSync(join(GOLDENS, 'index.json'))) {
  throw new Error('No goldens: run `pnpm goldens` first (python3 -I scripts/goldens.py).');
}
const index = JSON.parse(readFileSync(join(GOLDENS, 'index.json'), 'utf8')) as GoldenIndex;

function readTree(directory: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(directory, full).split(sep).join('/')] = readFileSync(full);
    }
  };
  walk(directory);
  return files;
}

function expectSameFiles(actual: Record<string, string>, directory: string) {
  const expected = readTree(directory);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [name, bytes] of Object.entries(expected)) {
    const got = Buffer.from(actual[name] ?? '', 'utf8');
    expect(got.equals(bytes), `${name} differs`).toBe(true);
  }
}

let call: PythonCall;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(join(BUNDLE, 'bundle.json'), 'utf8')) as { file: string };
  const py = await startPyodide();
  call = installUpstream(py, new Uint8Array(readFileSync(join(BUNDLE, bundle.file))));
}, 120_000);

describe('generation in Pyodide matches upstream on the host', () => {
  it('runs the same upstream version', () => {
    const reply = call('info', []);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect((reply.result as { upstreamVersion: string }).upstreamVersion).toBe(
        index.upstreamVersion,
      );
    }
  });

  for (const [name, entry] of Object.entries(index.projects)) {
    const text = () => readFileSync(join(ROOT, 'upstream', entry.project), 'utf8');

    it(`${name}: MicroPython code`, () => {
      const reply = call('generate', [text()]);
      if (!reply.ok) throw new Error(reply.error.traceback ?? reply.error.message);
      const generated = reply.result as GeneratedProject;
      expectSameFiles(generated.files, join(GOLDENS, name, 'py'));
      expect(generated.warnings).toEqual(entry.warnings);
    });

    if (entry.board) {
      const board = entry.board;
      it(`${name}: board export for ${board.profile}`, () => {
        const reply = call('export_board', [text()]);
        if (!reply.ok) throw new Error(reply.error.traceback ?? reply.error.message);
        const exported = reply.result as BoardExport;
        expect(exported.profile).toBe(board.profile);
        expectSameFiles(exported.files, join(GOLDENS, name, 'board'));
        expect(exported.warnings).toEqual(board.warnings);
      });
    }
  }
});
