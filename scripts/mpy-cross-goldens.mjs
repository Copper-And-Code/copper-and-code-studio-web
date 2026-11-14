// What upstream's native mpy-cross gives for every .py of the examples, the generated goldens and
// runtime/program: the sha256 of each .mpy, and the full output for a few broken files.
// tests/py/mpy-cross.test.ts checks that mpy-cross in WebAssembly gives the same.
//
//   node scripts/mpy-cross-goldens.mjs <native mpy-cross>    (writes tests/fixtures/mpy-cross.json)
//
// The .py files are compiled by name from their own folder, as compile_python does.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// the generated goldens come from scripts/goldens.py, which CI runs first
export const SOURCES = [
  'upstream/examples',
  'upstream/runtime/program',
  'upstream/lvgl_mpy_studio/gen',
  'tests/fixtures/goldens',
];
export const BROKEN = {
  'invalid.py': 'x = 1\ndef f(:\n    pass\n',
  'indent.py': 'a = 1\n  b = 2\n',
  'unclosed.py': 'print("x"\n',
  'return.py': 'return 5\n',
  'nonlocal.py': 'def f():\n    nonlocal q\n',
};

export function sources() {
  const found = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.py')) found.push(relative(ROOT, path).split(sep).join('/'));
    }
  };
  for (const folder of SOURCES) walk(join(ROOT, folder));
  return found;
}

function native(mpyCross, name, data) {
  const folder = mkdtempSync(join(tmpdir(), 'lms-mpy-cross-'));
  try {
    writeFileSync(join(folder, name), data);
    let output = '';
    try {
      execFileSync(mpyCross, [name], { cwd: folder, stdio: 'pipe' });
    } catch (error) {
      output = String(error.stdout ?? '') + String(error.stderr ?? '');
    }
    const mpy = join(folder, name.replace(/\.py$/, '.mpy'));
    return { output, mpy: existsSync(mpy) ? readFileSync(mpy) : null };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mpyCross = process.argv[2];
  if (!mpyCross) {
    console.error('usage: node scripts/mpy-cross-goldens.mjs <native mpy-cross>');
    process.exit(2);
  }
  const version = execFileSync(mpyCross, ['--version']).toString().trim();
  const compiled = {};
  for (const path of sources()) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const result = native(mpyCross, name, readFileSync(join(ROOT, path)));
    // host Python in gen/ does not always compile for MicroPython: its error is kept instead
    compiled[path] = result.mpy
      ? createHash('sha256').update(result.mpy).digest('hex')
      : `error: ${result.output}`;
  }
  const broken = {};
  for (const [name, text] of Object.entries(BROKEN))
    broken[name] = native(mpyCross, name, text).output;
  const out = join(ROOT, 'tests', 'fixtures', 'mpy-cross.json');
  writeFileSync(out, JSON.stringify({ version, compiled, broken }, null, 2) + '\n');
  console.log(
    `${Object.keys(compiled).length} files, ${Object.keys(broken).length} errors: ${out}`,
  );
}
