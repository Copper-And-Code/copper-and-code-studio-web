// The IDE's dialogs, one at a time: questions with buttons, a line of text, and the file chooser
// that stands in for the desktop's file dialog (a place, its folders, a file name).
import { LitElement, css, html, nothing } from 'lit';
import { tr } from '../i18n/tr.ts';
import {
  type Entry,
  type FileStore,
  type Location,
  baseName,
  joinPath,
  parentPath,
} from '../storage/store.ts';

export interface Button<T> {
  label: string;
  value: T;
  /** The default button, taken by Enter. */
  primary?: boolean;
}

export interface ChooseOptions {
  mode: 'open' | 'save' | 'folder';
  title: string;
  stores: FileStore[];
  suggested?: Location | null;
  /** Which files to show in open and save mode, e.g. project files only. */
  accept?: (name: string) => boolean;
  /** Chromium: adds a folder of the PC as a place; resolves to its store, or null. */
  addFolder?: () => Promise<FileStore | null>;
  acceptLabel?: string;
}

type Request =
  | {
      kind: 'message';
      title: string;
      text: string;
      detail?: string;
      buttons: Button<unknown>[];
      cancel: unknown;
      resolve: (value: unknown) => void;
    }
  | {
      kind: 'text';
      title: string;
      label: string;
      value: string;
      resolve: (value: string | null) => void;
    }
  | { kind: 'choose'; options: ChooseOptions; resolve: (value: Location | null) => void };

export class Dialogs extends LitElement {
  static override properties = {
    current: { state: true },
    place: { state: true },
    folder: { state: true },
    entries: { state: true },
    name: { state: true },
    problem: { state: true },
    newFolderName: { state: true },
  };

  private queue: Request[] = [];
  current: Request | null = null;
  // file chooser state
  place: FileStore | null = null;
  folder = '';
  entries: Entry[] = [];
  name = '';
  problem = '';
  /** The name being typed for a new folder, or null when none is being made. */
  newFolderName: string | null = null;

  static override styles = css`
    dialog {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      width: min(520px, calc(100vw - 32px));
      box-sizing: border-box;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 0.35);
    }
    h1 {
      font-size: 1.1rem;
      margin: 0 0 10px;
    }
    p {
      margin: 6px 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .detail {
      color: var(--muted);
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button,
    select,
    input {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 12px;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-accent);
    }
    button:focus-visible,
    select:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: 8px 0;
    }
    .row input {
      flex: 1;
      min-width: 0;
    }
    .crumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      align-items: center;
      color: var(--muted);
    }
    .crumbs button {
      border: none;
      background: none;
      padding: 2px 4px;
      color: var(--accent);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      height: 240px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    li button {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      border-radius: 0;
      background: none;
      padding: 4px 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    li button[aria-selected='true'] {
      background: var(--selection);
    }
    li button:disabled {
      color: var(--muted);
    }
    .problem {
      color: var(--danger);
    }
  `;

  /** A question with buttons; Escape gives cancel. */
  message<T>(
    title: string,
    text: string,
    buttons: Button<T>[],
    cancel: T,
    detail?: string,
  ): Promise<T> {
    return new Promise<T>((resolve) =>
      this.push({
        kind: 'message',
        title,
        text,
        detail,
        buttons,
        cancel,
        resolve: resolve as (value: unknown) => void,
      }),
    );
  }

  /** An error or a notice, with OK. */
  notice(title: string, text: string): Promise<void> {
    return this.message(
      title,
      text,
      [{ label: tr('OK'), value: undefined, primary: true }],
      undefined,
    );
  }

  askText(title: string, label: string, value = ''): Promise<string | null> {
    return new Promise((resolve) => this.push({ kind: 'text', title, label, value, resolve }));
  }

  choose(options: ChooseOptions): Promise<Location | null> {
    return new Promise((resolve) => this.push({ kind: 'choose', options, resolve }));
  }

  private push(request: Request): void {
    this.queue.push(request);
    if (!this.current) void this.next();
  }

  private async next(): Promise<void> {
    this.current = this.queue.shift() ?? null;
    if (!this.current) return;
    if (this.current.kind === 'choose') await this.startChooser(this.current.options);
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector('dialog');
    if (dialog && !dialog.open) dialog.showModal();
    this.renderRoot.querySelector<HTMLElement>('[autofocus]')?.focus();
  }

  private finish(value: unknown): void {
    const request = this.current;
    if (!request) return;
    this.renderRoot.querySelector('dialog')?.close();
    this.current = null;
    if (request.kind === 'message') request.resolve(value);
    else if (request.kind === 'text') request.resolve(value as string | null);
    else request.resolve(value as Location | null);
    void this.next();
  }

  private cancelValue(): unknown {
    return this.current?.kind === 'message' ? this.current.cancel : null;
  }

  // ---- file chooser ----

  private places(options: ChooseOptions): FileStore[] {
    return options.mode === 'open' ? options.stores : options.stores.filter((s) => !s.readOnly);
  }

  private async startChooser(options: ChooseOptions): Promise<void> {
    const places = this.places(options);
    const suggested = options.suggested;
    const place = places.find((s) => s.id === suggested?.store) ?? places[0] ?? null;
    this.place = place;
    this.name = options.mode === 'save' && suggested ? baseName(suggested.path) : '';
    this.problem = '';
    this.newFolderName = null;
    await this.enter(place && suggested?.store === place.id ? parentPath(suggested.path) : '');
  }

  private async enter(folder: string): Promise<void> {
    this.folder = folder;
    try {
      this.entries = this.place ? await this.place.list(folder) : [];
      this.problem = '';
    } catch (error) {
      if (folder) return this.enter('');
      this.entries = [];
      this.problem = String(error instanceof Error ? error.message : error);
    }
  }

  private async changePlace(id: string, options: ChooseOptions): Promise<void> {
    if (id === '+folder' && options.addFolder) {
      const store = await options.addFolder();
      if (store && !options.stores.includes(store)) options.stores.push(store);
      this.place = store ?? this.place;
    } else {
      this.place = this.places(options).find((s) => s.id === id) ?? this.place;
    }
    await this.enter('');
  }

  private async newFolder(): Promise<void> {
    const place = this.place;
    const name = this.newFolderName?.trim();
    this.newFolderName = null;
    if (!place || !name) return;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      this.problem = tr('Invalid name: {name}', { name });
      return;
    }
    try {
      await place.makeFolder(joinPath(this.folder, name));
      await this.enter(joinPath(this.folder, name));
    } catch (error) {
      this.problem = String(error instanceof Error ? error.message : error);
    }
  }

  private accept(options: ChooseOptions): void {
    if (!this.place) return;
    if (options.mode === 'folder') {
      this.finish({ store: this.place.id, path: this.folder });
      return;
    }
    const name = this.name.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      this.problem = tr('Invalid name: {name}', { name });
      return;
    }
    if (
      options.mode === 'open' &&
      !this.entries.some((e) => e.kind === 'file' && e.name === name)
    ) {
      this.problem = tr('No such file: {path}', { path: name });
      return;
    }
    this.finish({ store: this.place.id, path: joinPath(this.folder, name) });
  }

  private renderChooser(options: ChooseOptions) {
    const parts = this.folder ? this.folder.split('/') : [];
    const accept = options.accept ?? (() => true);
    const label =
      options.acceptLabel ??
      (options.mode === 'open' ? tr('Open') : options.mode === 'save' ? tr('Save') : tr('Choose'));
    return html`
      <h1 id="dialog-title">${options.title}</h1>
      <div class="row">
        <label for="place">${tr('Place:')}</label>
        <select
          id="place"
          @change=${(e: Event) => this.changePlace((e.target as HTMLSelectElement).value, options)}
        >
          ${this.places(options).map(
            (s) => html`<option value=${s.id} ?selected=${s === this.place}>${s.label}</option>`,
          )}
          ${
            options.addFolder
              ? html`<option value="+folder">${tr('A folder of the PC…')}</option>`
              : nothing
          }
        </select>
        ${
          options.mode !== 'open'
            ? html`<button type="button" @click=${() => (this.newFolderName = '')}>
                ${tr('New Folder')}
              </button>`
            : nothing
        }
      </div>
      ${
        this.newFolderName !== null
          ? html`<div class="row">
              <label for="folder-name">${tr('New Folder')}:</label>
              <input
                id="folder-name"
                .value=${this.newFolderName}
                @input=${(e: Event) => (this.newFolderName = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') void this.newFolder();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    this.newFolderName = null;
                  }
                }}
              />
              <button type="button" @click=${this.newFolder}>${tr('OK')}</button>
            </div>`
          : nothing
      }
      <nav class="crumbs" aria-label=${tr('Folder')}>
        <button type="button" @click=${() => this.enter('')}>${this.place?.label ?? ''}</button>
        ${parts.map(
          (part, i) =>
            html`/<button type="button" @click=${() => this.enter(parts.slice(0, i + 1).join('/'))}>
                ${part}
              </button>`,
        )}
      </nav>
      <ul role="listbox" aria-label=${tr('Files')}>
        ${
          this.folder
            ? html`<li>
                <button type="button" @click=${() => this.enter(parentPath(this.folder))}>
                  📁 ..
                </button>
              </li>`
            : nothing
        }
        ${this.entries.map((entry) =>
          entry.kind === 'folder'
            ? html`<li>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  @click=${() => this.enter(joinPath(this.folder, entry.name))}
                >
                  📁 ${entry.name}
                </button>
              </li>`
            : html`<li>
                <button
                  type="button"
                  role="option"
                  aria-selected=${entry.name === this.name ? 'true' : 'false'}
                  ?disabled=${options.mode === 'folder' || !accept(entry.name)}
                  @click=${() => (this.name = entry.name)}
                  @dblclick=${() => {
                    this.name = entry.name;
                    this.accept(options);
                  }}
                >
                  📄 ${entry.name}
                </button>
              </li>`,
        )}
      </ul>
      ${
        options.mode !== 'folder'
          ? html`<div class="row">
              <label for="name">${tr('Name:')}</label>
              <input
                id="name"
                .value=${this.name}
                ?readonly=${options.mode === 'open'}
                ?autofocus=${options.mode === 'save'}
                @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.accept(options)}
              />
            </div>`
          : nothing
      }
      ${this.problem ? html`<p class="problem" role="alert">${this.problem}</p>` : nothing}
      <div class="buttons">
        <button type="button" @click=${() => this.finish(null)}>${tr('Cancel')}</button>
        <button
          type="button"
          class="primary"
          ?autofocus=${options.mode !== 'save'}
          @click=${() => this.accept(options)}
        >
          ${label}
        </button>
      </div>
    `;
  }

  override render() {
    const request = this.current;
    let body: unknown = nothing;
    if (request?.kind === 'message') {
      body = html`
        <h1 id="dialog-title">${request.title}</h1>
        <p>${request.text}</p>
        ${request.detail ? html`<p class="detail">${request.detail}</p>` : nothing}
        <div class="buttons">
          ${request.buttons.map(
            (button) =>
              html`<button
                type="button"
                class=${button.primary ? 'primary' : ''}
                ?autofocus=${button.primary}
                @click=${() => this.finish(button.value)}
              >
                ${button.label}
              </button>`,
          )}
        </div>
      `;
    } else if (request?.kind === 'text') {
      body = html`
        <h1 id="dialog-title">${request.title}</h1>
        <div class="row">
          <label for="text">${request.label}</label>
          <input
            id="text"
            autofocus
            .value=${request.value}
            @input=${(e: Event) => (request.value = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.finish(request.value)}
          />
        </div>
        <div class="buttons">
          <button type="button" @click=${() => this.finish(null)}>${tr('Cancel')}</button>
          <button type="button" class="primary" @click=${() => this.finish(request.value)}>
            ${tr('OK')}
          </button>
        </div>
      `;
    } else if (request?.kind === 'choose') {
      body = this.renderChooser(request.options);
    }
    return html`<dialog
      aria-labelledby="dialog-title"
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.finish(this.cancelValue());
      }}
    >
      ${body}
    </dialog>`;
  }
}

customElements.define('lms-dialogs', Dialogs);

declare global {
  interface HTMLElementTagNameMap {
    'lms-dialogs': Dialogs;
  }
}
