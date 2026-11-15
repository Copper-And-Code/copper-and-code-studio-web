// The pure-Python packages that upstream's device package needs and Pyodide lacks, put into the
// upstream bundle, each downloaded once from PyPI into .cache/python/ and checked against its
// sha256: mpremote at the release upstream's pyproject.toml pins, and platformdirs, which mpremote
// imports, at the version the pinned Pyodide release lists (the npm package of Pyodide does not
// carry its wheels). pyserial is not one of them: py/serial/ gives its interface over the page's
// ports.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, '.cache', 'python');
const PYODIDE = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));

export const WHEELS = [
  {
    name: 'mpremote',
    version: '1.29.0',
    url: 'https://files.pythonhosted.org/packages/51/85/f68fbcfe4d1ce32a7f2154a48f68195d4f256e3700b69ad0d5b758ee3b37/mpremote-1.29.0-py3-none-any.whl',
    sha256: 'dedac688bcd65b9d4d5b7a66119332f2830000088321107994959333f53e41c8',
  },
  {
    name: 'platformdirs',
    version: '4.9.4',
    url: 'https://files.pythonhosted.org/packages/63/d7/97f7e3a6abb67d8080dd406fd4df842c2be0efaf712d1c899c32a075027c/platformdirs-4.9.4-py3-none-any.whl',
    sha256: '68a9a4619a666ea6439f2ff250c12a853cd1cbd5158d258bd824a7df6be2f868',
    pin: 'pyodide',
  },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function fail(message) {
  throw new Error(`python-deps: ${message}`);
}

/** The version upstream pins for a dependency, from its pyproject.toml. */
function upstreamPin(name) {
  const text = readFileSync(join(ROOT, 'upstream', 'pyproject.toml'), 'utf8');
  return new RegExp(`"${name}==([^"]+)"`).exec(text)?.[1];
}

/** The version the pinned Pyodide release lists for a package. */
function pyodidePin(name) {
  const lock = JSON.parse(readFileSync(join(PYODIDE, 'pyodide-lock.json'), 'utf8'));
  return lock.packages?.[name]?.version;
}

async function wheel(spec) {
  const pin = spec.pin === 'pyodide' ? pyodidePin(spec.name) : upstreamPin(spec.name);
  if (pin !== spec.version) {
    const who = spec.pin === 'pyodide' ? 'Pyodide lists' : 'upstream pins';
    fail(`${who} ${spec.name}==${pin}, scripts/python-deps.mjs has ${spec.version}`);
  }
  const cached = join(CACHE, spec.url.slice(spec.url.lastIndexOf('/') + 1));
  if (existsSync(cached) && sha256(readFileSync(cached)) === spec.sha256) {
    return readFileSync(cached);
  }
  console.log(`python-deps: downloading ${spec.url}`);
  const response = await fetch(spec.url);
  if (!response.ok) fail(`${spec.url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== spec.sha256) fail(`${spec.url}: sha256 ${sha256(data)}`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, data);
  return data;
}

/** Every file of the wheels, by its path inside site-packages, licences included. */
export async function wheelFiles() {
  const files = {};
  for (const spec of WHEELS) {
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(await wheel(spec))))) {
      if (!name.endsWith('/') && !name.endsWith('.pyc')) files[name] = data;
    }
  }
  return files;
}
