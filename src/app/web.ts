// The web version of a game, as upstream's ui/main_files.py open_in_browser and program_in_browser:
// build/web.py builds the folder in Python (py/lms_bridge.py web_build, program_web), with the
// game compiled by mpy-cross in WebAssembly first. The desktop then serves dist/<name>-web and
// opens it; here the folder is opened from the IDE's own site (public/preview/sw.js), and can be
// downloaded as a zip or written to a folder of the PC to publish it.
import { html } from 'lit';
import { zipSync, type Zippable } from 'fflate';
import { tr } from '../i18n/tr.ts';
import type { MpyCross } from '../mpy/mpy-cross.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { download } from '../storage/download.ts';
import { canOpenFolders, pickFolder } from '../storage/folders.ts';
import { type FileStore, type Location, joinPath, walkFiles } from '../storage/store.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import { copyProgramIntoPython } from './run.ts';

/** build/web.py MARKER and OLD_MARKERS: only a folder made by the IDE is replaced. */
const MARKERS = ['.copper-and-code-studio-web', '.lvgl-mpy-studio-web'];
const RUNTIME_FILES = ['micropython.mjs', 'micropython.wasm'];
const PREVIEW_CACHE = 'lms-web-preview';
// In local time, as a zip stores dates: the same files give the same zip in every time zone.
const MTIME = new Date(2026, 0, 1);

export interface WebBuild {
  /** The folder's name, <project>-web. */
  name: string;
  files: Map<string, Uint8Array>;
}

export interface WebHooks {
  /** save_project, or save_files_in for a program. */
  saveProject(): Promise<boolean>;
  saveFilesIn(folder: Location): Promise<boolean>;
  output(text: string): void;
  appendError(text: string): void;
  status(text: string, ms?: number): void;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  wasm: 'application/wasm',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

function contentType(path: string): string {
  return TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

export class WebPublisher {
  private building = false;
  private runtimeReady: Promise<void> | null = null;

  constructor(
    private readonly python: PythonBridge,
    private readonly mpyCross: MpyCross,
    private readonly dialogs: Dialogs,
    private readonly stores: Map<string, FileStore>,
    private readonly hooks: WebHooks,
    private readonly site = new URL(import.meta.env.BASE_URL, location.origin),
  ) {}

  get busy(): boolean {
    return this.building;
  }

  /** The runtime of the site, where build/web.py's web_runtime() looks for it. */
  private ensureRuntime(): Promise<void> {
    this.runtimeReady ??= (async () => {
      const folder = await this.python.call<string>('web_runtime_dir');
      for (const name of RUNTIME_FILES) {
        const response = await fetch(new URL(`runtime/${name}`, this.site));
        if (!response.ok) throw new Error(`runtime/${name}: HTTP ${response.status}`);
        await this.python.writeFile(
          `${folder}/${name}`,
          new Uint8Array(await response.arrayBuffer()),
        );
      }
    })();
    this.runtimeReady.catch(() => (this.runtimeReady = null));
    return this.runtimeReady;
  }

  private async readBuild(built: {
    directory: string;
    name: string;
    files: string[];
  }): Promise<WebBuild> {
    const files = new Map<string, Uint8Array>();
    for (const path of built.files) {
      const data = await this.python.readFile(`${built.directory}/${path}`);
      if (data) files.set(path, data);
    }
    return { name: built.name, files };
  }

  /** open_in_browser: the open project, saved, generated, compiled, with its page and runtime. */
  async openProject(): Promise<boolean> {
    if (this.building || !(await this.hooks.saveProject())) return false;
    return this.run(async () => {
      await this.ensureRuntime();
      const plan = await this.python.call<{
        jobs: { path: string; name: string; args: string[]; key: string }[];
        cache: string;
      }>('web_prepare');
      for (const job of plan.jobs) {
        const data = await this.python.readFile(job.path);
        if (!data) continue;
        const result = await this.mpyCross.compile(job.name, data, job.args);
        if (result.code === 0 && result.mpy) {
          await this.python.writeFile(`${plan.cache}/${job.key}.mpy`, result.mpy);
        } else {
          await this.python.writeFile(
            `${plan.cache}/${job.key}.out`,
            new TextEncoder().encode(result.output),
          );
        }
      }
      return this.python.call<{ directory: string; name: string; files: string[] }>('web_build');
    });
  }

  /** program_in_browser: a program without pages, its folder and the runtime. */
  async openProgram(entry: Location): Promise<boolean> {
    const store = this.stores.get(entry.store);
    if (this.building || !store) return false;
    const folder = { store: entry.store, path: entry.path.split('/').slice(0, -1).join('/') };
    if (!(await this.hooks.saveFilesIn(folder))) return false;
    return this.run(async () => {
      await this.ensureRuntime();
      const inPython = await copyProgramIntoPython(this.python, store, entry);
      return this.python.call<{ directory: string; name: string; files: string[] }>(
        'program_web',
        inPython,
      );
    });
  }

  private async run(
    build: () => Promise<{ directory: string; name: string; files: string[] }>,
  ): Promise<boolean> {
    this.building = true;
    this.hooks.status(tr('Building the web version…'), 0);
    let result: WebBuild;
    try {
      result = await this.readBuild(await build());
    } catch (error) {
      this.hooks.appendError(error instanceof Error ? error.message : String(error));
      this.hooks.status(tr('Web version failed'), 5000);
      return false;
    } finally {
      this.building = false;
    }
    this.hooks.output(
      tr('Web version in {path}: to publish it, copy the folder to a static host.', {
        path: result.name,
      }) + '\n',
    );
    this.hooks.status(tr('Web version ready: {name}', { name: result.name }), 5000);
    this.last = result;
    await this.deliver(result);
    return true;
  }

  /** The last web version built, for the tests. */
  last: WebBuild | null = null;

  /** The folder as a zip, its own name at the top, as the desktop's dist/<name>-web. */
  zip(build: WebBuild): Uint8Array {
    const entries: Zippable = {};
    for (const [path, data] of build.files)
      entries[`${build.name}/${path}`] = [data, { mtime: MTIME }];
    return zipSync(entries, { level: 6 });
  }

  /** Into a folder of the PC: <folder>/<name>, replaced only when the IDE made it. */
  async saveToFolder(build: WebBuild): Promise<boolean> {
    const store = await pickFolder();
    if (!store) return false;
    const existing = await walkFiles(store, build.name).catch((): string[] => []);
    const ours = MARKERS.some((marker) => existing.includes(joinPath(build.name, marker)));
    if (existing.length && !ours) {
      await this.dialogs.notice(
        tr('Save to a Folder…'),
        tr('{path} already exists and is not a web build made by this IDE: move or rename it', {
          path: `${store.label}/${build.name}`,
        }),
      );
      return false;
    }
    if (existing.length) await store.remove(build.name);
    for (const [path, data] of build.files) await store.write(joinPath(build.name, path), data);
    this.hooks.status(tr('Saved {path}', { path: `${store.label}/${build.name}` }), 5000);
    return true;
  }

  /** The folder under the site's preview/, served by public/preview/sw.js; null without it. */
  async preview(build: WebBuild): Promise<string | null> {
    if (!('serviceWorker' in navigator) || typeof caches === 'undefined') return null;
    try {
      const scope = new URL('preview/', this.site);
      const registration = await navigator.serviceWorker.register(new URL('sw.js', scope), {
        scope: scope.pathname,
      });
      await activated(registration);
      await caches.delete(PREVIEW_CACHE); // one web version at a time, as the desktop serves one
      const cache = await caches.open(PREVIEW_CACHE);
      const id = `${build.name}-${Date.now().toString(36)}`;
      for (const [path, data] of build.files) {
        await cache.put(
          new URL(`${id}/${path}`, scope).href,
          new Response(data as Uint8Array<ArrayBuffer>, {
            headers: { 'Content-Type': contentType(path) },
          }),
        );
      }
      return new URL(`${id}/index.html`, scope).href;
    } catch {
      return null;
    }
  }

  /** What to do with the folder built: open it, download it, or write it to the PC. */
  private async deliver(build: WebBuild): Promise<void> {
    const url = await this.preview(build);
    await this.dialogs.custom<boolean>(
      tr('Web Version'),
      (finish) => html`
        <p>
          ${tr(
            '{name} is ready: open it here, or take the folder to publish it on a static host.',
            {
              name: build.name,
            },
          )}
        </p>
        <div class="buttons">
          ${
            url
              ? html`<a
                  class="button primary"
                  href=${url}
                  target="_blank"
                  rel="noopener"
                  data-testid="web-open"
                  @click=${() => finish(true)}
                  >${tr('Open in a New Tab')}</a
                >`
              : null
          }
          <button
            type="button"
            data-testid="web-zip"
            @click=${() => {
              download(`${build.name}.zip`, this.zip(build), 'application/zip');
              finish(true);
            }}
          >
            ${tr('Download as Zip')}
          </button>
          ${
            canOpenFolders
              ? html`<button
                  type="button"
                  @click=${() => void this.saveToFolder(build).then((saved) => saved && finish(true))}
                >
                  ${tr('Save to a Folder…')}
                </button>`
              : null
          }
          <button type="button" @click=${() => finish(true)}>${tr('Close')}</button>
        </div>
      `,
      false,
    );
  }
}

/** The registration's worker, once it controls its scope. */
function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker || worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
    });
  });
}
