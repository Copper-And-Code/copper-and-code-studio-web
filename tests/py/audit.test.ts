// Audit of the bundle (PLAN.md phase 1): every module of upstream's Qt-free packages imports in
// Pyodide, and none pulls in Qt, pyserial or mpremote. Where a module needs a process, a socket
// or a thread at run time is listed in docs/pyodide-audit.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { installUpstream } from '../../src/py/boot.ts';
import { ROOT, startPyodide } from './pyodide-node.mjs';
import type { PyodideInterface } from 'pyodide';

let py: PyodideInterface;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'public/py/bundle.json'), 'utf8')) as {
    file: string;
  };
  py = await startPyodide();
  installUpstream(py, new Uint8Array(readFileSync(join(ROOT, 'public/py', bundle.file))));
}, 120_000);

it('imports every module of the bundle, without Qt, pyserial or mpremote', () => {
  const result = JSON.parse(
    py.runPython(`
import importlib, json, pkgutil, sys
import lvgl_mpy_studio
names = sorted(m.name for m in pkgutil.walk_packages(lvgl_mpy_studio.__path__, 'lvgl_mpy_studio.'))
failed = {}
for name in names:
    try:
        importlib.import_module(name)
    except Exception as error:
        failed[name] = f'{type(error).__name__}: {error}'
forbidden = sorted(m for m in sys.modules if m.split('.')[0] in ('PySide6', 'serial', 'mpremote', 'qtawesome'))
json.dumps({'names': names, 'failed': failed, 'forbidden': forbidden})
`) as string,
  ) as { names: string[]; failed: Record<string, string>; forbidden: string[] };
  expect(result.names.length).toBeGreaterThan(40);
  expect(result.failed).toEqual({});
  expect(result.forbidden).toEqual([]);
});
