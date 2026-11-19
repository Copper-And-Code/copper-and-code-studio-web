// A context menu at a point, as QMenu.exec(position): arrow keys, Enter and Escape; a click outside
// closes it.
import { LitElement, css, html, nothing } from 'lit';
import { captureName } from '../i18n/tr.ts';
import type { MenuItem } from './menu-bar.ts';

export class ContextMenu extends LitElement {
  static override properties = {
    open: { state: true },
  };

  open: { x: number; y: number; items: MenuItem[]; label: string } | null = null;
  private returnFocus: HTMLElement | null = null;

  static override styles = css`
    [role='menu'] {
      position: fixed;
      z-index: 30;
      min-width: 200px;
      padding: 4px;
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
      display: flex;
      flex-direction: column;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      text-align: left;
      cursor: pointer;
    }
    button:disabled {
      color: var(--muted);
      cursor: default;
    }
    button:hover:not(:disabled),
    button:focus-visible {
      background: var(--bg);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 4px 2px;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.outside, true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.outside, true);
  }

  private readonly outside = (event: PointerEvent) => {
    if (this.open && !event.composedPath().includes(this)) this.close(false);
  };

  /** Opens at the pointer, or under the element for the keyboard's Menu key. */
  show(event: MouseEvent | KeyboardEvent, items: MenuItem[], label: string): void {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const box = target.getBoundingClientRect();
    const x = event instanceof MouseEvent && event.clientX ? event.clientX : box.left + 12;
    const y = event instanceof MouseEvent && event.clientY ? event.clientY : box.bottom;
    this.returnFocus = target;
    this.open = { x, y, items, label };
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
    );
  }

  close(focus = true): void {
    this.open = null;
    if (focus) this.returnFocus?.focus();
  }

  private keys(event: KeyboardEvent): void {
    const items = [
      ...this.renderRoot.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    ];
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') this.close();
    else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
  }

  override render() {
    const open = this.open;
    if (!open) return nothing;
    return html`<div
      role="menu"
      aria-label=${open.label}
      style="left: ${open.x}px; top: ${open.y}px"
      @keydown=${this.keys}
    >
      ${open.items.map((item) =>
        'separator' in item || 'section' in item
          ? html`<hr aria-hidden="true" />`
          : html`<button
              type="button"
              role="menuitem"
              data-id=${item.id ?? nothing}
              data-capture=${`context-menu.${captureName(item.label)}`}
              ?disabled=${item.disabled}
              @click=${() => {
                this.close();
                item.action?.();
              }}
            >
              ${item.label}
            </button>`,
      )}
    </div>`;
  }
}

customElements.define('lms-context-menu', ContextMenu);

declare global {
  interface HTMLElementTagNameMap {
    'lms-context-menu': ContextMenu;
  }
}
