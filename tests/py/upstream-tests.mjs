// Runs upstream's pytest suite inside Pyodide, under Node (PLAN.md phase 1).
//
// Upstream is copied into Pyodide's memory, so a test can never write into the submodule.
// Tests that cannot run in a browser are listed, with a reason, in tests/py/exclusions.json;
// everything else must pass.
//
//   node tests/py/upstream-tests.mjs            run, fail on any failure outside the exclusions
//   node tests/py/upstream-tests.mjs --survey   run everything, print a summary per file
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, copyIn, startPyodide } from './pyodide-node.mjs';

// Upstream's own dependencies apart from Qt (pyproject.toml), and its test tools.
const PACKAGES = ['pyserial==3.5', 'mpremote==1.29.0', 'hypothesis==6.170.14'];
const survey = process.argv.includes('--survey');
const exclusions = JSON.parse(readFileSync(join(ROOT, 'tests/py/exclusions.json'), 'utf8'));

const t0 = performance.now();
const py = await startPyodide();
await py.loadPackage(['pytest', 'micropip'], { messageCallback: () => {} });
await py.pyimport('micropip').install(PACKAGES);
copyIn(py, join(ROOT, 'upstream'), '/up');

const args = [
  '-q',
  '--continue-on-collection-errors',
  '-p',
  'no:cacheprovider',
  '-o',
  'addopts=',
  '-W',
  'ignore::DeprecationWarning',
];
if (!survey) {
  for (const file of Object.keys(exclusions.files)) args.push(`--ignore=${file}`);
  for (const test of Object.keys(exclusions.tests)) args.push(`--deselect=${test}`);
}
args.push('tests');

py.globals.set('pytest_args', py.toPy(args));
const report = JSON.parse(
  await py.runPythonAsync(`
import json, os, sys
os.chdir('/up')
sys.path.insert(0, '/up')
import pytest

class Collector:
    def __init__(self):
        self.results = []
    def pytest_collectreport(self, report):
        if report.failed:
            self.results.append({'id': report.nodeid, 'outcome': 'error', 'when': 'collect', 'text': str(report.longrepr)[-2000:]})
    def pytest_runtest_logreport(self, report):
        if report.when == 'call' or report.outcome != 'passed':
            text = ''
            if report.outcome == 'skipped' and isinstance(report.longrepr, tuple):
                text = report.longrepr[2]
            elif report.outcome == 'failed':
                text = str(report.longrepr)[-2000:]
            outcome = 'error' if report.failed and report.when != 'call' else report.outcome
            self.results.append({'id': report.nodeid, 'outcome': outcome, 'when': report.when, 'text': text})

collector = Collector()
code = pytest.main(list(pytest_args), plugins=[collector])
json.dumps({'code': int(code), 'results': collector.results})
`),
);

const seconds = ((performance.now() - t0) / 1000).toFixed(0);
const count = (outcome) => report.results.filter((r) => r.outcome === outcome).length;
const summary = {
  passed: count('passed'),
  failed: count('failed'),
  errors: count('error'),
  skipped: count('skipped'),
};

if (survey) {
  const files = {};
  for (const r of report.results) {
    const file = r.id.split('::')[0];
    files[file] ??= { passed: 0, failed: 0, error: 0, skipped: 0, first: '' };
    files[file][r.outcome]++;
    if (!files[file].first && (r.outcome === 'failed' || r.outcome === 'error')) {
      const lines = r.text.split('\n').filter((l) => /^E\s|Error|error/.test(l));
      files[file].first = (lines.at(-1) ?? r.text.split('\n').at(-1) ?? '').trim().slice(0, 200);
    }
  }
  for (const [file, f] of Object.entries(files).sort()) {
    console.log(
      `${file}: ${f.passed} passed, ${f.failed} failed, ${f.error} errors, ${f.skipped} skipped${f.first ? `\n    ${f.first}` : ''}`,
    );
  }
  writeFileSync(join(ROOT, 'test-results-upstream-survey.json'), JSON.stringify(report, null, 1));
}

console.log(
  `upstream tests in Pyodide: ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} errors, ${summary.skipped} skipped (${seconds} s)`,
);
if (!survey) {
  for (const r of report.results.filter((x) => x.outcome === 'failed' || x.outcome === 'error')) {
    console.log(`\n--- ${r.outcome}: ${r.id}\n${r.text}`);
  }
  process.exit(summary.failed || summary.errors ? 1 : 0);
}
