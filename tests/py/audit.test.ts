// Audit of the bundle (PLAN.md phase 1): every module of upstream's Qt-free packages imports in
// Pyodide, and none pulls in Qt, pyserial or mpremote. The device package, there since phase 6,
// imports serial: it must be the bundle's py/serial/, not pyserial. Where a module needs a
// process, a socket or a thread at run time is listed in docs/pyodide-audit.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { installUpstream } from '../../src/py/boot.ts';
import { ROOT, startPyodide } from './pyodide-node.mjs';
import type { PyodideInterface } from 'pyodide';

let py: PyodideInterface;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'public/python/bundle.json'), 'utf8')) as {
    file: string;
  };
  py = await startPyodide();
  installUpstream(py, new Uint8Array(readFileSync(join(ROOT, 'public/python', bundle.file))));
}, 120_000);

it('imports every module of the bundle, without Qt, pyserial or mpremote', () => {
  const result = JSON.parse(
    py.runPython(`
import importlib, json, pkgutil, sys
import copper_and_code_studio
# walk_packages imports each package to look inside: device's modules are listed without that
top = [m for m in pkgutil.iter_modules(copper_and_code_studio.__path__, 'copper_and_code_studio.') if m.name != 'copper_and_code_studio.device']
names = []
for module in top:
    names.append(module.name)
    if module.ispkg:
        package = importlib.import_module(module.name)
        names.extend(m.name for m in pkgutil.walk_packages(package.__path__, module.name + '.'))
device_path = [copper_and_code_studio.__path__[0] + '/device']
device = ['copper_and_code_studio.device'] + [m.name for m in pkgutil.iter_modules(device_path, 'copper_and_code_studio.device.')]
names = sorted(names + device)
failed = {}
def load(group):
    for name in group:
        try:
            importlib.import_module(name)
        except Exception as error:
            failed[name] = f'{type(error).__name__}: {error}'
load([name for name in names if name not in device])
forbidden = sorted(m for m in sys.modules if m.split('.')[0] in ('PySide6', 'serial', 'mpremote', 'qtawesome'))
load(device)
after = sorted(m for m in sys.modules if m.split('.')[0] in ('PySide6', 'mpremote', 'qtawesome'))
serial = sys.modules.get('serial')
json.dumps({'names': names, 'device': device, 'failed': failed, 'forbidden': forbidden + after,
            'serial': getattr(serial, '__file__', None)})
`) as string,
  ) as {
    names: string[];
    device: string[];
    failed: Record<string, string>;
    forbidden: string[];
    serial: string | null;
  };
  expect(result.names.length).toBeGreaterThan(40);
  expect(result.device).toContain('copper_and_code_studio.device.service');
  expect(result.failed).toEqual({});
  expect(result.forbidden).toEqual([]);
  expect(result.serial).toBe('/lib/lms/serial/__init__.py');
});
