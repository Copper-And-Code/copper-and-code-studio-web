// The Toolbox, as upstream's ui/designer/scene.py ToolboxPanel: the widgets and components by
// category, a search field; drag one onto a page, or double click (or Enter) and then click
// where it goes. A component dropped on the Components strip goes to the project.
import { LitElement, css, html, nothing } from 'lit';
import type { DesignerController, ToolboxCategory } from '../app/designer.ts';
import { tr } from '../i18n/tr.ts';
import { WIDGET_MIME } from './designer-view.ts';

export class Toolbox extends LitElement {
  static override properties = {
    controller: { attribute: false },
    revision: { type: Number },
    categories: { state: true },
    search: { state: true },
  };

  controller: DesignerController | null = null;
  revision = 0;
  categories: ToolboxCategory[] = [];
  search = '';

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
    }
    input {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
    }
    input:focus-visible,
    [role='option']:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow: auto;
    }
    .category {
      font-weight: bold;
      padding: 4px 2px 2px;
    }
    [role='option'] {
      padding: 1px 8px;
      border-radius: 4px;
      cursor: grab;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    [role='option'][aria-selected='true'] {
      background: var(--selection);
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private loaded = -1;

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const revision = this.controller?.blocksRevision ?? 0;
    if (changed.has('controller') || revision !== this.loaded) {
      this.loaded = revision;
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const controller = this.controller;
    if (controller) this.categories = await controller.toolbox();
  }

  /** Toolbox.filter: by the name shown or by the type. */
  private visible(): ToolboxCategory[] {
    const needle = this.search.trim().toLowerCase();
    return this.categories
      .map((category) => ({
        ...category,
        entries: category.entries.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) || entry.type.toLowerCase().includes(needle),
        ),
      }))
      .filter((category) => category.entries.length);
  }

  private keys(event: KeyboardEvent, type: string): void {
    const items = [...this.renderRoot.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = items.indexOf(event.target as HTMLElement);
    if (event.key === 'ArrowDown') items[index + 1]?.focus();
    else if (event.key === 'ArrowUp') items[index - 1]?.focus();
    else if (event.key === 'Enter') this.controller?.arm(type);
    else return;
    event.preventDefault();
  }

  override render() {
    const armed = this.controller?.armed;
    return html`
      <input
        type="search"
        aria-label=${tr('Search a widget')}
        placeholder=${tr('Search a widget')}
        .value=${this.search}
        @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
      />
      <ul role="listbox" aria-label=${tr('Toolbox')} data-testid="toolbox">
        ${this.visible().map(
          (category) => html`
            <li class="category" role="presentation">${category.label}</li>
            ${category.entries.map(
              (entry) =>
                html`<li
                  role="option"
                  tabindex="0"
                  draggable="true"
                  title=${entry.type}
                  data-type=${entry.type}
                  aria-selected=${String(armed === entry.type)}
                  @dragstart=${(event: DragEvent) => {
                    event.dataTransfer?.setData(WIDGET_MIME, entry.type);
                    event.dataTransfer?.setData('text/plain', entry.type);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
                    if (this.controller) this.controller.dragging = entry.type;
                  }}
                  @dragend=${() => {
                    if (this.controller) this.controller.dragging = null;
                  }}
                  @dblclick=${() => this.controller?.arm(entry.type)}
                  @keydown=${(event: KeyboardEvent) => this.keys(event, entry.type)}
                >
                  ${entry.name}
                </li>`,
            )}
          `,
        )}
      </ul>
      ${
        armed
          ? html`<p role="status" data-testid="armed">
              ${tr('Click on the page to place it; Escape cancels.')}
            </p>`
          : nothing
      }
    `;
  }
}

customElements.define('lms-toolbox', Toolbox);

declare global {
  interface HTMLElementTagNameMap {
    'lms-toolbox': Toolbox;
  }
}
