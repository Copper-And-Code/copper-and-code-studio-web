import { LitElement, css, html, nothing } from 'lit';

export type MenuItem =
  | { separator: true }
  | {
      label: string;
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
  items: () => MenuItem[];
}

type Entry = Exclude<MenuItem, { separator: true }>;
const isEntry = (item: MenuItem): item is Entry => !('separator' in item);

/** The menu bar: menus that open on click, with arrow keys, Enter and Escape. */
export class MenuBar extends LitElement {
  static override properties = {
    menus: { attribute: false },
    open: { state: true },
    submenu: { state: true },
  };

  menus: Menu[] = [];
  open = -1;
  submenu: { index: number; items: MenuItem[] } | null = null;

  static override styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      position: relative;
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
    [role='menuitem'] {
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

  private toggle(index: number): void {
    this.submenu = null;
    this.open = this.open === index ? -1 : index;
    if (this.open >= 0) void this.updateComplete.then(() => this.focusItem(0));
  }

  private focusItem(position: number, menu?: Element | null): void {
    const root = menu ?? this.renderRoot.querySelector('.top [role="menu"]');
    const items = [
      ...(root?.querySelectorAll<HTMLButtonElement>(':scope > .item > [role="menuitem"]') ?? []),
    ].filter((item) => !item.disabled);
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
    const items = [
      ...(menu?.querySelectorAll<HTMLButtonElement>(':scope > .item > [role="menuitem"]') ?? []),
    ].filter((item) => !item.disabled);
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
          this.renderRoot.querySelectorAll<HTMLButtonElement>('.top > button')[top]?.focus();
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
        this.toggle(next);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  private renderItems(items: MenuItem[], label: string, sub: boolean): unknown {
    if (items.length === 0) return html`<div class="empty">(empty)</div>`;
    return items.map((item, index) =>
      isEntry(item)
        ? html`<div class="item">
            <button
              type="button"
              role="menuitem"
              data-id=${item.id ?? nothing}
              data-sub=${item.items ? '1' : nothing}
              aria-haspopup=${item.items ? 'menu' : nothing}
              aria-keyshortcuts=${item.shortcut?.replace(/Ctrl/g, 'Control') ?? nothing}
              ?disabled=${item.disabled}
              @click=${() => this.run(item, index)}
            >
              <span>${item.label}</span>
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
                    ${this.renderItems(this.submenu.items, item.label, true)}
                  </div>`
                : nothing
            }
          </div>`
        : html`<hr aria-hidden="true" data-menu=${label} />`,
    );
  }

  override render() {
    return this.menus.map(
      (menu, index) =>
        html`<div class="top" @keydown=${this.keydown}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded=${this.open === index ? 'true' : 'false'}
            @click=${() => this.toggle(index)}
          >
            ${menu.label}
          </button>
          ${
            this.open === index
              ? html`<div role="menu" aria-label=${menu.label}>
                  ${this.renderItems(menu.items(), menu.label, false)}
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
