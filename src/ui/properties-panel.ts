// The Properties panel, as upstream's ui/properties/panel.py: the properties the selected widgets
// have in common, by category or alphabetically, each with the editor of its type
// (PropertyDelegate); the message of a value refused; the Events tab of a single widget, where a
// double click makes the handler and opens it.
import { LitElement, css, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import type { DesignerController, PropertyRow } from '../app/designer.ts';
import { tr } from '../i18n/tr.ts';

type Tab = 'properties' | 'events';

/** A colour QColor accepts, as #RRGGBB for the browser's colour picker; null if not one. */
function pickerColor(text: string): string | null {
  const value = text.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${[...value.slice(1)].map((digit) => digit + digit).join('')}`.toLowerCase();
  }
  if (/^#[0-9a-f]{8}$/i.test(value)) return `#${value.slice(3)}`.toLowerCase(); // #AARRGGBB
  return null;
}

export class PropertiesPanel extends LitElement {
  static override properties = {
    controller: { attribute: false },
    revision: { type: Number },
    tab: { state: true },
    alphabetical: { state: true },
  };

  controller: DesignerController | null = null;
  revision = 0;
  tab: Tab = 'properties';
  alphabetical = false;
  /** A double click on an event: the handler, made if missing, in the Code tab. */
  onEvent: (widget: string, event: string) => void = () => {};

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }
    [role='tablist'] {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--border);
    }
    [role='tab'] {
      font: inherit;
      color: var(--muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 2px 10px;
      cursor: pointer;
    }
    [role='tab'][aria-selected='true'] {
      color: var(--text);
      border-bottom-color: var(--accent);
    }
    [role='tab']:focus-visible,
    input:focus-visible,
    select:focus-visible,
    button:focus-visible,
    tr:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .error {
      color: var(--danger);
      white-space: pre-wrap;
      margin: 0;
      padding: 3px;
    }
    .empty {
      color: var(--muted);
      margin: 0;
    }
    select,
    input,
    button {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 4px;
      min-width: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th,
    td {
      text-align: left;
      padding: 2px 4px;
      vertical-align: middle;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      font-weight: normal;
      color: var(--muted);
    }
    th.label {
      width: 45%;
      white-space: nowrap;
    }
    tr.group th {
      font-weight: bold;
      color: var(--text);
      padding-top: 6px;
    }
    td input:not([type='checkbox']) {
      width: 100%;
      box-sizing: border-box;
    }
    .with-button {
      display: flex;
      gap: 2px;
      align-items: center;
    }
    .with-button input[type='color'] {
      width: 28px;
      padding: 0;
      flex: none;
    }
    .events tr.bound td {
      font-weight: bold;
    }
    .events tbody tr {
      cursor: pointer;
    }
    .events tbody tr:hover {
      background: var(--bg);
    }
  `;

  /** The text typed into a row goes to the project when the editor is left or Enter is pressed. */
  private commit(row: PropertyRow, text: string): void {
    // Enter and the change that follows it carry the same text: it goes once
    if (text === row.value || this.committing.get(row.name) === text) return;
    this.committing.set(row.name, text);
    void this.controller?.setProperty(row.name, text).then(() => {
      this.committing.delete(row.name);
      // the edit is over: the field shows what the project holds now, a refused value included
      this.settled.add(row.name);
      this.requestUpdate();
    });
  }

  private readonly committing = new Map<string, string>();

  /** Rows whose edit was just committed: their editor takes the project's value again. */
  private readonly settled = new Set<string>();

  /**
   * The value an editor shows: the project's, except in the editor being typed into, which a
   * rebuild that arrives meanwhile must not overwrite.
   */
  private shown(row: PropertyRow): string {
    if (this.settled.delete(row.name)) return row.value;
    const active = (this.renderRoot as ShadowRoot).activeElement as HTMLInputElement | null;
    return active?.dataset.property === row.name ? active.value : row.value;
  }

  private textEditor(row: PropertyRow, list?: string) {
    return html`<input
      aria-label=${row.label}
      data-property=${row.name}
      .value=${live(this.shown(row))}
      list=${list ?? nothing}
      placeholder=${row.type === 'font' ? tr('built-in font') : nothing}
      @change=${(event: Event) => this.commit(row, (event.target as HTMLInputElement).value)}
      @keydown=${(event: KeyboardEvent) => {
        // WebKit fires no change on Enter in a field with suggestions
        if (event.key === 'Enter') this.commit(row, (event.target as HTMLInputElement).value);
        if (event.key === 'Escape') (event.target as HTMLInputElement).value = row.value;
      }}
    />`;
  }

  /** PropertyDelegate.createEditor. */
  private editor(row: PropertyRow) {
    const descriptor = row.descriptor;
    switch (row.type) {
      case 'number':
        return html`<input
          type="number"
          step="1"
          aria-label=${row.label}
          data-property=${row.name}
          min=${descriptor.min ?? -1000000}
          max=${descriptor.max ?? 1000000}
          .value=${live(this.shown(row))}
          @change=${(event: Event) => {
            const input = event.target as HTMLInputElement;
            // a QSpinBox holds an integer within its range
            const min = descriptor.min ?? -1000000;
            const max = descriptor.max ?? 1000000;
            const number = Math.round(Number(input.value || 0));
            const value = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
            this.commit(row, String(value));
          }}
        />`;
      case 'boolean':
        return html`<input
          type="checkbox"
          aria-label=${row.label}
          data-property=${row.name}
          .checked=${live(row.checked ?? false)}
          @change=${(event: Event) => {
            const checked = (event.target as HTMLInputElement).checked;
            void this.controller?.setProperty(row.name, checked ? 'true' : 'false', checked);
          }}
        />`;
      case 'select':
      case 'enum':
        // an editable combo box: the options, or any text
        return html`${this.textEditor(row, `options-${row.name}`)}
          <datalist id="options-${row.name}">
            ${(descriptor.options ?? []).map((option) => html`<option value=${option}></option>`)}
          </datalist>`;
      case 'color': {
        const picker = pickerColor(row.value);
        return html`<div class="with-button">
          ${this.textEditor(row)}
          <input
            type="color"
            title=${tr('Choose a colour')}
            aria-label=${tr('Choose a colour')}
            .value=${live(picker ?? '#000000')}
            @change=${(event: Event) =>
              this.commit(row, (event.target as HTMLInputElement).value.toUpperCase())}
          />
        </div>`;
      }
      case 'font':
        return html`${this.textEditor(row, 'project-fonts')}
          <datalist id="project-fonts">
            ${(this.controller?.propertiesView.fonts ?? []).map(
              (font) => html`<option value=${font}></option>`,
            )}
          </datalist>`;
      default:
        return this.textEditor(row);
    }
  }

  private renderRow(row: PropertyRow) {
    return html`<tr data-row=${row.name}>
      <th class="label" scope="row" title=${row.label}>${row.label}</th>
      <td>${this.editor(row)}</td>
    </tr>`;
  }

  private renderProperties() {
    const view = this.controller?.propertiesView;
    if (!view?.names.length) return html`<p class="empty">${tr('No selection')}</p>`;
    let body: unknown;
    if (this.alphabetical) {
      const rows = view.categories
        .flatMap((category) => category.rows)
        .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
      body = html`<tbody>
        ${rows.map((row) => this.renderRow(row))}
      </tbody>`;
    } else {
      body = view.categories.map(
        (category) =>
          html`<tbody data-category=${category.name}>
            <tr class="group">
              <th colspan="2" scope="rowgroup">${category.label}</th>
            </tr>
            ${category.rows.map((row) => this.renderRow(row))}
          </tbody>`,
      );
    }
    return html`
      <select
        aria-label=${tr('Order')}
        data-testid="properties-order"
        .value=${this.alphabetical ? 'alphabetical' : 'category'}
        @change=${(event: Event) =>
          (this.alphabetical = (event.target as HTMLSelectElement).value === 'alphabetical')}
      >
        <option value="category">${tr('By Category')}</option>
        <option value="alphabetical">${tr('Alphabetical')}</option>
      </select>
      <table data-testid="properties">
        <thead>
          <tr>
            <th scope="col">${tr('Properties')}</th>
            <th scope="col">${tr('Value')}</th>
          </tr>
        </thead>
        ${body}
      </table>
    `;
  }

  private renderEvents() {
    const view = this.controller?.propertiesView;
    const widget = view?.names.length === 1 ? view.names[0] : undefined;
    if (!widget || !view) return html`<p class="empty">${tr('No selection')}</p>`;
    return html`<table class="events" data-testid="events">
      <thead>
        <tr>
          <th scope="col">${tr('Event')}</th>
          <th scope="col">${tr('Description')}</th>
          <th scope="col">${tr('Handler')}</th>
        </tr>
      </thead>
      <tbody>
        ${view.events.map(
          (event) =>
            html`<tr
              class=${event.bound ? 'bound' : ''}
              tabindex="0"
              data-event=${event.event}
              @dblclick=${() => this.onEvent(widget, event.event)}
              @keydown=${(key: KeyboardEvent) =>
                key.key === 'Enter' && this.onEvent(widget, event.event)}
            >
              <td>${event.event}</td>
              <td title=${event.description}>${event.description}</td>
              <td>${event.handler}</td>
            </tr>`,
        )}
      </tbody>
    </table>`;
  }

  override render() {
    const message = this.controller?.propertiesMessage ?? '';
    const tabs: [Tab, string][] = [
      ['properties', tr('Properties')],
      ['events', tr('Events')],
    ];
    return html`
      ${
        message
          ? html`<p class="error" role="alert" data-testid="properties-error">${message}</p>`
          : nothing
      }
      <div role="tablist">
        ${tabs.map(
          ([tab, label]) =>
            html`<button
              type="button"
              role="tab"
              id="properties-tab-${tab}"
              data-testid="properties-tab-${tab}"
              aria-selected=${String(this.tab === tab)}
              aria-controls="properties-panel-${tab}"
              tabindex=${this.tab === tab ? 0 : -1}
              @click=${() => (this.tab = tab)}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  this.tab = this.tab === 'properties' ? 'events' : 'properties';
                  void this.updateComplete.then(() =>
                    this.renderRoot
                      .querySelector<HTMLElement>(`#properties-tab-${this.tab}`)
                      ?.focus(),
                  );
                }
              }}
            >
              ${label}
            </button>`,
        )}
      </div>
      <div
        role="tabpanel"
        id="properties-panel-${this.tab}"
        aria-labelledby="properties-tab-${this.tab}"
      >
        ${this.tab === 'properties' ? this.renderProperties() : this.renderEvents()}
      </div>
    `;
  }
}

customElements.define('lms-properties-panel', PropertiesPanel);

declare global {
  interface HTMLElementTagNameMap {
    'lms-properties-panel': PropertiesPanel;
  }
}
