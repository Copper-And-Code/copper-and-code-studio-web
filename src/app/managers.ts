// The desktop's managers of what lives outside a project: the board profiles
// (ui/profile_manager.py) and the blocks (ui/blocks_manager.py). Upstream keeps both in its
// configuration folder (platform.config_dir); here that folder is in Pyodide's file system, and
// ConfigSync keeps a copy of it in the browser's private storage.
import { html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { N_, tr } from '../i18n/tr.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { type FileStore, joinPath, walkFiles } from '../storage/store.ts';
import type { Dialogs } from '../ui/dialogs.ts';

/** The configuration folder of upstream, kept in a store of the browser. */
export class ConfigSync {
  private folder = '';

  constructor(
    private readonly python: PythonBridge,
    readonly store: FileStore,
  ) {}

  /** At start-up: the kept files back into Python, then the blocks read again. */
  async load(): Promise<void> {
    this.folder = await this.python.call<string>('config_dir');
    for (const path of await walkFiles(this.store)) {
      const data = await this.store.read(path);
      if (!data) continue;
      const target = `${this.folder}/${path}`;
      await this.python.makeFolder(target.slice(0, target.lastIndexOf('/')));
      await this.python.writeFile(target, data);
    }
    await this.python.call('config_reload');
  }

  /** After a change: the folder as Python has it, files gone removed. */
  async save(): Promise<void> {
    if (!this.folder) this.folder = await this.python.call<string>('config_dir');
    const files = await this.python.call<string[]>('config_files');
    for (const path of files) {
      const data = await this.python.readFile(`${this.folder}/${path}`);
      if (data) await this.store.write(path, data);
    }
    const kept = new Set(files);
    for (const path of await walkFiles(this.store)) {
      if (!kept.has(path)) await this.store.remove(path);
    }
  }
}

interface Profile {
  id: string;
  name: string;
  adapter: string;
  revision: number;
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  scale: number;
  origin?: string;
  diagnostics?: { code: string; path: string }[];
  [key: string]: unknown;
}

/** [field, label shown (none: beside the one before), what a screen reader says, min, max] */
const PROFILE_NUMBERS: [keyof Profile, string, string, number, number][] = [
  ['revision', N_('Revision'), N_('Revision'), 1, 1000000],
  ['logicalWidth', N_('Logical Resolution'), N_('Logical width'), 1, 10000],
  ['logicalHeight', '', N_('Logical height'), 1, 10000],
  ['physicalWidth', N_('Physical Resolution'), N_('Physical width'), 1, 10000],
  ['physicalHeight', '', N_('Physical height'), 1, 10000],
  ['scale', N_('Scale'), N_('Scale'), 1, 16],
];

/** Project → Manage Board Profiles…: ProfileManagerDialog. True when the catalog changed. */
export async function manageProfiles(
  python: PythonBridge,
  dialogs: Dialogs,
  config: ConfigSync,
): Promise<boolean> {
  const view = await python.call<{
    profiles: Profile[];
    adapters: string[];
    loadError: string | null;
  }>('profiles_manager');
  const profiles = new Map<string, Profile>(view.profiles.map((p) => [p.id, p]));
  let selected: string | null = view.profiles[0]?.id ?? null;
  let message = view.loadError ?? '';
  const refresh = () => dialogs.refresh();
  const current = () => (selected ? profiles.get(selected) : undefined);
  const diagnose = async (profile: Profile) => {
    profile.diagnostics = await python.call<Profile['diagnostics']>(
      'profile_check',
      strip(profile),
    );
  };
  /** _draft_changed: an edit makes the profile custom and raises its revision once. */
  const edit = async (field: keyof Profile, value: string | number) => {
    const original = current();
    if (!original) return;
    const profile: Profile = { ...original, [field]: value, origin: 'custom' };
    const content = (p: Profile) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(p).filter(([key]) => !['origin', 'revision', 'diagnostics'].includes(key)),
        ),
      );
    if (
      field !== 'revision' &&
      content(original) !== content(profile) &&
      profile.revision <= original.revision
    )
      profile.revision = original.revision + 1;
    await diagnose(profile);
    profiles.set(profile.id, profile);
    refresh();
  };
  const add = async (source?: Profile) => {
    const profile = await python.call<Profile>('profile_new', source ? strip(source) : null);
    await diagnose(profile);
    profiles.set(profile.id, profile);
    selected = profile.id;
    refresh();
  };
  const describe = (errors: Profile['diagnostics']) =>
    (errors ?? []).map((item) => `${item.code}:${item.path}`).join('; ');
  const apply = async (finish: (value: boolean) => void) => {
    const invalid = [...profiles.values()].filter((p) => p.diagnostics?.length);
    if (invalid.length) {
      message = `${tr('Invalid')}: ${invalid.map((p) => describe(p.diagnostics)).join('; ')}`;
      refresh();
      return;
    }
    try {
      await python.call('profiles_apply', [...profiles.values()].map(strip));
      await config.save();
    } catch (error) {
      message = `${tr('Save Error')}: ${error instanceof Error ? error.message : String(error)}`;
      refresh();
      return;
    }
    finish(true);
  };
  const names = () => [...profiles.values()].map((p) => p.name);
  return dialogs.custom<boolean>(
    tr('Board Profile Manager'),
    (finish) => {
      const profile = current();
      return html`
        <div class="table">
          <table data-testid="profiles">
            <thead>
              <tr>
                ${[
                  N_('Name'),
                  N_('Origin'),
                  N_('Adapter'),
                  N_('Logical'),
                  N_('Physical'),
                  N_('Revision'),
                  N_('Status'),
                ].map((label) => html`<th scope="col">${tr(label)}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${[...profiles.values()].map(
                (p) =>
                  html`<tr
                    tabindex="0"
                    aria-selected=${String(p.id === selected)}
                    data-profile=${p.id}
                    @click=${() => {
                      selected = p.id;
                      refresh();
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        selected = p.id;
                        refresh();
                      }
                    }}
                  >
                    <td>
                      ${names().filter((name) => name === p.name).length > 1 ? `${p.name} [${p.id}]` : p.name}
                    </td>
                    <td>${p.origin === 'builtin' ? tr('Built-in') : tr('Custom profile')}</td>
                    <td>${p.adapter}</td>
                    <td>${p.logicalWidth}×${p.logicalHeight}</td>
                    <td>${p.physicalWidth}×${p.physicalHeight}</td>
                    <td>${p.revision}</td>
                    <td>${p.diagnostics?.length ? tr('Invalid') : tr('Valid')}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>
        ${
          profile
            ? html`<div class="grid">
                <label for="profile-name">${tr('Name')}</label>
                <input
                  id="profile-name"
                  .value=${live(profile.name)}
                  @change=${(e: Event) => void edit('name', (e.target as HTMLInputElement).value)}
                />
                <label for="profile-id">${tr('Stable ID')}</label>
                <input id="profile-id" readonly .value=${live(profile.id)} />
                <label for="profile-adapter">${tr('Adapter')}</label>
                <select
                  id="profile-adapter"
                  .value=${live(profile.adapter)}
                  @change=${(e: Event) => void edit('adapter', (e.target as HTMLSelectElement).value)}
                >
                  ${view.adapters.map((adapter) => html`<option value=${adapter}>${adapter}</option>`)}
                </select>
                ${PROFILE_NUMBERS.map(
                  ([field, label, spoken, min, max]) => html`
                    <label for="profile-${String(field)}">${label ? tr(label) : ''}</label>
                    <input
                      id="profile-${String(field)}"
                      type="number"
                      min=${min}
                      max=${max}
                      aria-label=${tr(spoken)}
                      .value=${live(String(profile[field]))}
                      @change=${(e: Event) => {
                        const value = Math.round(Number((e.target as HTMLInputElement).value));
                        void edit(
                          field,
                          Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min,
                        );
                      }}
                    />
                  `,
                )}
                <span></span>
                <span>${tr('Driver and buffers are fixed by the adapter firmware.')}</span>
              </div>`
            : nothing
        }
        ${message ? html`<p class="problem" role="alert">${message}</p>` : nothing}
        <div class="buttons">
          <button type="button" @click=${() => void add()}>${tr('New')}</button>
          <button type="button" ?disabled=${!profile} @click=${() => profile && void add(profile)}>
            ${tr('Duplicate')}
          </button>
          <button
            type="button"
            ?disabled=${!profile}
            @click=${async () => {
              if (!profile) return;
              const restored = await python.call<Profile | null>('profile_default', profile.id);
              if (restored) {
                await diagnose(restored);
                profiles.set(profile.id, restored);
                refresh();
              }
            }}
          >
            ${tr('Restore Default')}
          </button>
          <button
            type="button"
            ?disabled=${!profile}
            @click=${() => {
              if (!profile) return;
              // a question inside a dialog: the browser's own, as QMessageBox.question over it
              if (
                window.confirm(
                  tr('Delete profile {name}? Projects keep their portable copy.', {
                    name: profile.name,
                  }),
                )
              ) {
                profiles.delete(profile.id);
                selected = profiles.keys().next().value ?? null;
                refresh();
              }
            }}
          >
            ${tr('Delete')}
          </button>
          <button
            type="button"
            @click=${async () => {
              for (const hidden of await python.call<Profile[]>('profiles_hidden')) {
                if (!profiles.has(hidden.id)) {
                  await diagnose(hidden);
                  profiles.set(hidden.id, hidden);
                }
              }
              refresh();
            }}
          >
            ${tr('Restore Hidden Profiles')}
          </button>
        </div>
        <div class="buttons">
          <button type="button" @click=${() => finish(false)}>${tr('Cancel')}</button>
          <button type="button" class="primary" @click=${() => void apply(finish)}>
            ${tr('Apply')}
          </button>
        </div>
      `;
    },
    false,
    true,
  );
}

/** A profile as upstream keeps it: without what the dialog adds. */
function strip(profile: Profile): Profile {
  const rest: Profile = { ...profile };
  delete rest.diagnostics;
  return rest;
}

interface BlockRow {
  id: string;
  name: string;
  version: string;
  origin: 'standard' | 'user' | 'project';
  originLabel: string;
  author: string;
  license: string;
  usedBy: string[];
  details: string[];
}

/** Project → Block Manager…: BlocksDialog. Resolves when it closes; true if blocks changed. */
export async function manageBlocks(
  python: PythonBridge,
  dialogs: Dialogs,
  config: ConfigSync,
  chooseFolder: () => Promise<{ store: FileStore; path: string } | null>,
): Promise<boolean> {
  let view = await python.call<{ blocks: BlockRow[]; problems: string[] }>('blocks_view');
  let selected: string | null = view.blocks[0]?.id ?? null;
  let message = '';
  let changed = false;
  const refresh = () => dialogs.refresh();
  const after = async (result: {
    select?: string | null;
    blocks: BlockRow[];
    problems: string[];
  }) => {
    view = result;
    selected = result.select ?? view.blocks[0]?.id ?? null;
    changed = true;
    await config.save();
    refresh();
  };
  const run = async (task: () => Promise<void>) => {
    message = '';
    try {
      await task();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    refresh();
  };
  /** Add from Folder…: the folder copied into Python, checked, asked about, installed. */
  const addFromFolder = () =>
    run(async () => {
      const chosen = await chooseFolder();
      if (!chosen) return;
      const target = await python.call<string>('block_source_folder');
      for (const path of await walkFiles(chosen.store, chosen.path)) {
        const data = await chosen.store.read(path);
        if (!data) continue;
        const relative = chosen.path ? path.slice(chosen.path.length + 1) : path;
        const file = joinPath(target, relative);
        await python.makeFolder(file.slice(0, file.lastIndexOf('/')));
        await python.writeFile(file, data);
      }
      const check = await python.call<{ error: string | null; question?: string | null }>(
        'block_check',
      );
      if (check.error) {
        message = check.error;
        return;
      }
      if (check.question && !window.confirm(check.question)) return;
      await after(await python.call('block_install'));
    });
  // one dialog at a time: Add from Folder… closes the manager, chooses, and opens it again
  for (;;) {
    const action = await dialogs.custom<'close' | 'add'>(
      tr('Block Manager'),
      (finish) => {
        const block = view.blocks.find((item) => item.id === selected);
        return html`
          <p>
            ${tr(
              'Blocks add components to the toolbox: a folder with a description and MicroPython modules. The simulator runs the code of a block on this computer, as it runs the code of a project: install blocks from people you trust.',
            )}
          </p>
          <div class="table">
            <table data-testid="blocks">
              <thead>
                <tr>
                  ${[
                    N_('Name'),
                    N_('Version'),
                    N_('Origin'),
                    N_('Author'),
                    N_('Licence'),
                    N_('Used by'),
                  ].map((label) => html`<th scope="col">${tr(label)}</th>`)}
                </tr>
              </thead>
              <tbody>
                ${view.blocks.map(
                  (item) =>
                    html`<tr
                      tabindex="0"
                      data-block=${item.id}
                      aria-selected=${String(item.id === selected)}
                      @click=${() => {
                        selected = item.id;
                        refresh();
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          selected = item.id;
                          refresh();
                        }
                      }}
                    >
                      <td>${item.name}</td>
                      <td>${item.version}</td>
                      <td>${item.originLabel}</td>
                      <td>${item.author}</td>
                      <td>${item.license}</td>
                      <td>${item.usedBy.join(', ')}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>
          ${
            block
              ? html`<div data-testid="block-details">
                  <p><strong>${block.name}</strong> — <code>${block.id}</code></p>
                  ${block.details.map((line) => html`<p>${line}</p>`)}
                </div>`
              : nothing
          }
          ${view.problems.map((problem) => html`<p class="problem">${problem}</p>`)}
          ${message ? html`<p class="problem" role="alert">${message}</p>` : nothing}
          <div class="buttons">
            <button type="button" @click=${() => finish('add')}>${tr('Add from Folder…')}</button>
            <button
              type="button"
              ?disabled=${block?.origin !== 'project'}
              @click=${() =>
                run(
                  async () => block && after(await python.call('block_install_project', block.id)),
                )}
            >
              ${tr('Install from Project')}
            </button>
            <button
              type="button"
              ?disabled=${block?.origin !== 'user'}
              @click=${() =>
                run(async () => {
                  if (!block) return;
                  const question = await python.call<string>('block_remove_question', block.id);
                  if (window.confirm(question))
                    await after(await python.call('block_remove', block.id));
                })}
            >
              ${tr('Remove')}
            </button>
            <button
              type="button"
              @click=${() =>
                run(async () => {
                  await config.load();
                  view = await python.call('blocks_view');
                  changed = true;
                })}
            >
              ${tr('Reload')}
            </button>
          </div>
          <div class="buttons">
            <button type="button" class="primary" @click=${() => finish('close')}>
              ${tr('Close')}
            </button>
          </div>
        `;
      },
      'close',
      true,
    );
    if (action === 'close') return changed;
    await addFromFolder();
  }
}
