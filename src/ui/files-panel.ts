// The Files panel, as upstream's ui/files.py FilesPanel: a folder of a place (the workspace, the
// examples, a folder of the PC), its tree without caches and hidden files; double click or Enter
// opens a file; the context menu (right click, the Menu key or Shift+F10) runs, creates, renames
// and deletes.
import { LitElement, css, html, nothing } from 'lit';
import { tr } from '../i18n/tr.ts';
import { type Entry, type FileStore, type Location, joinPath } from '../storage/store.ts';
import type { MenuItem } from './menu-bar.ts';

const HIDDEN = new Set(['__pycache__']); // and names starting with a dot

interface Node {
  path: string;
  name: string;
  kind: Entry['kind'];
}

export class FilesPanel extends LitElement {
  static override properties = {
    store: { attribute: false },
    folder: { attribute: false },
    revision: { type: Number },
    open: { state: true },
    listing: { state: true },
    menu: { state: true },
    selected: { state: true },
  };

  store: FileStore | null = null;
  folder: Location | null = null;
  /** Grows when files may have changed: the tree is read again. */
  revision = 0;
  /** Folders expanded, by path. */
  open = new Set<string>();
  listing = new Map<string, Node[]>();
  menu: { x: number; y: number; items: MenuItem[] } | null = null;
  selected: string | null = null;
  /** Opens a file. */
  onOpen: (location: Location) => void = () => {};
  /** The menu of an entry, or of the folder itself (null). */
  menuFor: (entry: (Node & { location: Location }) | null) => MenuItem[] = () => [];
  onChooseFolder: () => void = () => {};

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      gap: 4px;
    }
    .top {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
    }
    .top span {
      overflow-wrap: anywhere;
      color: var(--muted);
    }
    button {
      font: inherit;
      color: inherit;
    }
    .choose {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    ul ul {
      padding-left: 14px;
    }
    [role='treeitem'] {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    [role='treeitem'][aria-selected='true'] {
      background: var(--selection);
    }
    [role='treeitem']:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .tree {
      flex: 1 1 auto;
      overflow: auto;
      min-height: 60px;
    }
    .empty {
      color: var(--muted);
    }
    [role='menu'] {
      position: fixed;
      z-index: 30;
      min-width: 200px;
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
      display: flex;
      flex-direction: column;
    }
    [role='menuitem'] {
      text-align: left;
      background: none;
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
    }
    [role='menuitem']:hover,
    [role='menuitem']:focus-visible {
      background: var(--bg);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    [role='menuitem']:disabled {
      color: var(--muted);
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 4px 2px;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.outside);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.outside);
  }

  private readonly outside = (event: PointerEvent) => {
    if (this.menu && !event.composedPath().includes(this)) this.menu = null;
  };

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('store') || changed.has('folder')) {
      this.open = new Set();
      this.listing = new Map();
      void this.reload();
    } else if (changed.has('revision')) {
      void this.reload();
    }
  }

  /** Reads the folder and the open subfolders again, after a change. */
  async reload(): Promise<void> {
    const root = this.folder?.path;
    if (!this.store || root === undefined) return;
    const children = new Map<string, Node[]>();
    for (const folder of [root, ...this.open]) {
      try {
        children.set(folder, await this.list(folder));
      } catch {
        // a folder that went away meanwhile
      }
    }
    this.listing = children;
  }

  private async list(folder: string): Promise<Node[]> {
    const entries = (await this.store?.list(folder)) ?? [];
    return entries
      .filter((entry) => !HIDDEN.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => ({ ...entry, path: joinPath(folder, entry.name) }));
  }

  private async toggle(node: Node): Promise<void> {
    const open = new Set(this.open);
    if (open.has(node.path)) open.delete(node.path);
    else {
      open.add(node.path);
      const children = new Map(this.listing);
      children.set(node.path, await this.list(node.path));
      this.listing = children;
    }
    this.open = open;
  }

  private location(node: Node): Location {
    return { store: this.store?.id ?? '', path: node.path };
  }

  private activate(node: Node): void {
    this.selected = node.path;
    if (node.kind === 'folder') void this.toggle(node);
    else this.onOpen(this.location(node));
  }

  private showMenu(event: MouseEvent | KeyboardEvent, node: Node | null): void {
    event.preventDefault();
    event.stopPropagation();
    if (node) this.selected = node.path;
    const items = this.menuFor(node ? { ...node, location: this.location(node) } : null);
    const target = event.target as HTMLElement;
    const box = target.getBoundingClientRect();
    const x = event instanceof MouseEvent && event.clientX ? event.clientX : box.left + 12;
    const y = event instanceof MouseEvent && event.clientY ? event.clientY : box.bottom;
    this.menu = { x, y, items };
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
    );
  }

  private menuKeys(event: KeyboardEvent): void {
    const items = [
      ...this.renderRoot.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    ];
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') this.menu = null;
    else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
  }

  private itemKeys(event: KeyboardEvent, node: Node): void {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      this.showMenu(event, node);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.activate(node);
    } else if (event.key === 'ArrowRight' && node.kind === 'folder' && !this.open.has(node.path)) {
      void this.toggle(node);
    } else if (event.key === 'ArrowLeft' && node.kind === 'folder' && this.open.has(node.path)) {
      void this.toggle(node);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = [...this.renderRoot.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const index = items.indexOf(event.target as HTMLElement);
      items[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      event.preventDefault();
    }
  }

  private renderNodes(folder: string): unknown {
    const nodes = this.listing.get(folder);
    if (!nodes) return nothing;
    return nodes.map(
      (node) =>
        html`<li role="none">
          <button
            type="button"
            role="treeitem"
            data-path=${node.path}
            aria-expanded=${node.kind === 'folder' ? String(this.open.has(node.path)) : nothing}
            aria-selected=${String(this.selected === node.path)}
            title=${node.path}
            @click=${() => {
              this.selected = node.path;
              if (node.kind === 'folder') void this.toggle(node);
            }}
            @dblclick=${() => node.kind === 'file' && this.onOpen(this.location(node))}
            @keydown=${(event: KeyboardEvent) => this.itemKeys(event, node)}
            @contextmenu=${(event: MouseEvent) => this.showMenu(event, node)}
          >
            ${node.kind === 'folder' ? (this.open.has(node.path) ? '▾ 📁' : '▸ 📁') : '　 '}
            ${node.name}
          </button>
          ${
            node.kind === 'folder' && this.open.has(node.path)
              ? html`<ul role="group">
                  ${this.renderNodes(node.path)}
                </ul>`
              : nothing
          }
        </li>`,
    );
  }

  private renderMenu() {
    const menu = this.menu;
    if (!menu) return nothing;
    return html`<div
      role="menu"
      aria-label=${tr('Files')}
      style="left: ${menu.x}px; top: ${menu.y}px"
      @keydown=${this.menuKeys}
    >
      ${menu.items.map((item) =>
        'separator' in item
          ? html`<hr aria-hidden="true" />`
          : html`<button
              type="button"
              role="menuitem"
              data-id=${item.id ?? nothing}
              ?disabled=${item.disabled}
              @click=${() => {
                this.menu = null;
                item.action?.();
              }}
            >
              ${item.label}
            </button>`,
      )}
    </div>`;
  }

  override render() {
    const folder = this.folder;
    const label = folder
      ? `${this.store?.label ?? folder.store}${folder.path ? `: ${folder.path}` : ''}`
      : tr('No folder: open one, or run a program.');
    return html`
      <div class="top">
        <span data-testid="files-folder">${label}</span>
        <button type="button" class="choose" @click=${() => this.onChooseFolder()}>
          ${tr('Open Folder…')}
        </button>
      </div>
      ${
        folder
          ? html`<div
              class="tree"
              @contextmenu=${(event: MouseEvent) => this.showMenu(event, null)}
            >
              <ul role="tree" aria-label=${tr('Files')}>
                ${this.renderNodes(folder.path)}
              </ul>
            </div>`
          : nothing
      }
      ${this.renderMenu()}
    `;
  }
}

customElements.define('lms-files-panel', FilesPanel);

declare global {
  interface HTMLElementTagNameMap {
    'lms-files-panel': FilesPanel;
  }
}
