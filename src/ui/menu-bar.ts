import { LitElement, css, html, nothing } from 'lit';
import { captureName, tr } from '../i18n/tr.ts';

export type MenuItem =
  | { separator: true }
  /** A heading inside a menu, as QMenu.addSection. */
  | { section: string }
  | {
      label: string;
      /** A checkable action: shown with its mark, read as checked or not. */
      checked?: boolean;
      shortcut?: string;
      disabled?: boolean;
      /** For e2e tests and for the keyboard: a stable name. */
      id?: string;
      action?: () => void;
      /** A submenu, built when it is opened (recent files, examples, boards). */
      items?: () => MenuItem[] | Promise<MenuItem[]>;
    };

export interface Menu {
  label: string;
  /** The tooltip of the menu's button. */
  title?: string;
  /** Called before the menu opens, as QMenu.aboutToShow: its items may change. */
  onOpen?: () => Promise<void> | void;
  items: () => MenuItem[];
}

type Entry = Exclude<MenuItem, { separator: true } | { section: string }>;
const isEntry = (item: MenuItem): item is Entry => !('separator' in item) && !('section' in item);
const ITEMS = ':scope > .item > [role^="menuitem"]';

/**
 * The menu bar, an ARIA menubar: menus that open on click, or from the keyboard. One top item is
 * in the Tab order; Left and Right move between the menus, Down, Enter or Space opens one, Home and
 * End go to the first and the last; inside a menu, Up and Down, Right into a submenu, Escape back.
 * F10 brings the focus here from anywhere in the IDE (src/main.ts).
 */
export class MenuBar extends LitElement {
  static override properties = {
    menus: { attribute: false },
    label: {},
    open: { state: true },
    submenu: { state: true },
  };

  menus: Menu[] = [];
  /** The menubar's name for a screen reader. */
  label = '';
  open = -1;
  /** The top item in the Tab order: the last one used. */
  private current = 0;
  submenu: { index: number; items: MenuItem[] } | null = null;

  static override styles = css`
    :host {
      display: block;
      position: relative;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
    }
    .top {
      position: relative;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
    }
    button:disabled {
      color: var(--muted);
      cursor: default;
    }
    .top > button[aria-expanded='true'],
    button:hover:not(:disabled),
    button:focus-visible {
      background: var(--bg);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    [role='menu'] {
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 20;
      min-width: 240px;
      max-width: min(420px, calc(100vw - 16px));
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
      display: flex;
      flex-direction: column;
    }
    [role='menu'] [role='menu'] {
      top: 0;
      left: 100%;
    }
    [role^='menuitem'] {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item {
      position: relative;
    }
    .shortcut {
      color: var(--muted);
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 4px 2px;
      width: calc(100% - 4px);
    }
    .mark {
      display: inline-block;
      width: 1.2em;
    }
    .section {
      color: var(--muted);
      font-size: 0.85em;
      padding: 6px 10px 2px;
    }
    .empty {
      color: var(--muted);
      padding: 4px 10px;
    }
    @media (max-width: 720px) {
      [role='menu'] [role='menu'] {
        left: 16px;
        top: 100%;
      }
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
    if (!event.composedPath().includes(this)) this.close();
  };

  close(): void {
    this.open = -1;
    this.submenu = null;
  }

  private async toggle(index: number): Promise<void> {
    this.submenu = null;
    this.current = index;
    if (this.open !== index) await this.menus[index]?.onOpen?.();
    this.open = this.open === index ? -1 : index;
    if (this.open >= 0) void this.updateComplete.then(() => this.focusItem(0));
  }

  private tops(): HTMLButtonElement[] {
    return [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.top > button')];
  }

  /** The focus on a top item: the first one, or the one used last. */
  focusMenuBar(index = this.current): void {
    const tops = this.tops();
    const count = tops.length;
    if (!count) return;
    this.current = ((index % count) + count) % count;
    this.requestUpdate();
    tops[this.current]?.focus();
  }

  private topKeydown(event: KeyboardEvent, index: number): void {
    if (this.open >= 0) return; // the open menu's keys
    switch (event.key) {
      case 'ArrowRight':
        this.focusMenuBar(index + 1);
        break;
      case 'ArrowLeft':
        this.focusMenuBar(index - 1);
        break;
      case 'Home':
        this.focusMenuBar(0);
        break;
      case 'End':
        this.focusMenuBar(this.menus.length - 1);
        break;
      case 'ArrowDown':
        this.current = index;
        void this.toggle(index);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private focusItem(position: number, menu?: Element | null): void {
    const root = menu ?? this.renderRoot.querySelector('.top [role="menu"]');
    const items = [...(root?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])].filter(
      (item) => !item.disabled,
    );
    const count = items.length;
    if (count) items[((position % count) + count) % count]?.focus();
  }

  private async run(item: Entry, index: number): Promise<void> {
    if (item.items) {
      this.submenu = { index, items: await item.items() };
      await this.updateComplete;
      this.focusItem(0, this.renderRoot.querySelector('[role="menu"] [role="menu"]'));
      return;
    }
    this.close();
    item.action?.();
  }

  private keydown(event: KeyboardEvent): void {
    if (this.open < 0) return;
    const menu = (event.target as HTMLElement).closest('[role="menu"]');
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])].filter(
      (item) => !item.disabled,
    );
    const position = items.indexOf(event.target as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        this.focusItem(position + 1, menu);
        break;
      case 'ArrowUp':
        this.focusItem(position - 1, menu);
        break;
      case 'Escape': {
        const top = this.open;
        if (this.submenu && menu !== this.renderRoot.querySelector('.top [role="menu"]')) {
          this.submenu = null;
          this.focusItem(0);
        } else {
          this.close();
          this.focusMenuBar(top);
        }
        break;
      }
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (event.key === 'ArrowRight' && (event.target as HTMLElement).dataset.sub) {
          (event.target as HTMLButtonElement).click();
          break;
        }
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = (this.open + step + this.menus.length) % this.menus.length;
        this.open = -1;
        void this.toggle(next);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  /** path: the data-capture name of the menu, as menu-run or menu-file.recent-files. */
  private renderItems(items: MenuItem[], label: string, sub: boolean, path: string): unknown {
    if (items.length === 0) return html`<div class="empty">${tr('(empty)')}</div>`;
    return items.map((item, index) =>
      isEntry(item)
        ? html`<div class="item">
            <button
              type="button"
              role=${item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked=${item.checked === undefined ? nothing : String(item.checked)}
              data-id=${item.id ?? nothing}
              data-capture=${`${path}.${captureName(item.label)}`}
              data-sub=${item.items ? '1' : nothing}
              aria-haspopup=${item.items ? 'menu' : nothing}
              aria-keyshortcuts=${item.shortcut?.replace(/Ctrl/g, 'Control') ?? nothing}
              ?disabled=${item.disabled}
              @click=${() => this.run(item, index)}
            >
              <span
                >${item.checked === undefined ? nothing : html`<span class="mark" aria-hidden="true">${item.checked ? '✓' : ''}</span>`}${item.label}</span
              >
              ${
                item.shortcut
                  ? html`<span class="shortcut" aria-hidden="true">${item.shortcut}</span>`
                  : item.items
                    ? html`<span class="shortcut" aria-hidden="true">▸</span>`
                    : nothing
              }
            </button>
            ${
              !sub && this.submenu?.index === index
                ? html`<div role="menu" aria-label=${item.label}>
                    ${this.renderItems(
                      this.submenu.items,
                      item.label,
                      true,
                      `${path}.${captureName(item.label)}`,
                    )}
                  </div>`
                : nothing
            }
          </div>`
        : 'section' in item
          ? html`<div class="section" role="presentation">${item.section}</div>`
          : html`<hr aria-hidden="true" data-menu=${label} />`,
    );
  }

  override render() {
    // the menubar inside the shadow root, so its menu items are its own children for the
    // accessibility tree
    return html`<div class="bar" role="menubar" aria-label=${this.label}>
      ${this.renderMenus()}
    </div>`;
  }

  private renderMenus() {
    return this.menus.map(
      (menu, index) =>
        html`<div class="top" @keydown=${this.keydown}>
          <button
            type="button"
            role="menuitem"
            data-capture=${`menu-${captureName(menu.label)}`}
            tabindex=${index === this.current ? '0' : '-1'}
            aria-haspopup="menu"
            title=${menu.title ?? nothing}
            aria-expanded=${this.open === index ? 'true' : 'false'}
            @click=${() => void this.toggle(index)}
            @keydown=${(event: KeyboardEvent) => this.topKeydown(event, index)}
          >
            ${menu.label}
          </button>
          ${
            this.open === index
              ? html`<div role="menu" aria-label=${menu.label}>
                  ${this.renderItems(
                    menu.items(),
                    menu.label,
                    false,
                    `menu-${captureName(menu.label)}`,
                  )}
                </div>`
              : nothing
          }
        </div>`,
    );
  }
}

customElements.define('lms-menu-bar', MenuBar);

declare global {
  interface HTMLElementTagNameMap {
    'lms-menu-bar': MenuBar;
  }
}
