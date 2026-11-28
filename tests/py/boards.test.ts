// Every board profile that comes with upstream is in the bundle, is valid and generates in
// Pyodide. Upstream checks the same in test_every_builtin_board_is_valid_and_generates, but in
// tests/test_board_support.py, which imports PySide6 when it loads and so stays out of the Pyodide
// run (tests/py/exclusions.json, upstream request 4). The example projects name only three of the
// boards, so the goldens do not reach the others.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { installUpstream, type PythonCall } from '../../src/py/boot.ts';
import { ROOT, startPyodide } from './pyodide-node.mjs';
import type { PyodideInterface } from 'pyodide';

const BOARDS = join(ROOT, 'upstream/copper_and_code_studio/boards');

interface BoardFile {
  id: string;
  logicalWidth: number;
  logicalHeight: number;
}

const files = readdirSync(BOARDS)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(BOARDS, name), 'utf8')) as BoardFile);

let py: PyodideInterface;
let call: PythonCall;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
    file: string;
  };
  py = await startPyodide();
  call = installUpstream(
    py,
    new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))),
  );
}, 120_000);

it('the IDE lists every board of upstream, with its size', () => {
  const reply = call('profiles', []);
  if (!reply.ok) throw new Error(reply.error.traceback ?? reply.error.message);
  const listed = (
    reply.result as { id: string; width: number; height: number; origin: string }[]
  ).filter((profile) => profile.origin === 'builtin');
  expect(files.length).toBeGreaterThan(0);
  expect(listed.map(({ id, width, height }) => ({ id, width, height })).sort(byId)).toEqual(
    files
      .map((file) => ({ id: file.id, width: file.logicalWidth, height: file.logicalHeight }))
      .sort(byId),
  );
});

it.each(files.map((file) => file.id))('%s is valid and generates', (id) => {
  const result = JSON.parse(
    py.runPython(`
import json, tempfile
from pathlib import Path
from copper_and_code_studio.core.boards import adapter_requirements, builtin_profiles, validate_profile
from copper_and_code_studio.core.model import Project
from copper_and_code_studio.gen.board_gen import generate_board

profile = next(profile for profile in builtin_profiles() if profile["id"] == ${JSON.stringify(id)})
validate_profile(profile)
project = Project("board")
project.set_display_size(profile["logicalWidth"], profile["logicalHeight"])
project.board = profile
project.add_widget(project.pages[0], "button")
target = Path(tempfile.mkdtemp(prefix="lms-board-test-"))
generate_board(project, profile, target)
json.dumps({
    "modules": adapter_requirements(profile)["modules"] == profile["firmware"]["modules"],
    "size": f'LOGICAL_SIZE = ({profile["logicalWidth"]}, {profile["logicalHeight"]})' in (target / "board_adapter.py").read_text(),
    "id": json.loads((target / "board_profile.json").read_text())["id"],
})
`) as string,
  ) as { modules: boolean; size: boolean; id: string };
  expect(result).toEqual({ modules: true, size: true, id });
});

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
