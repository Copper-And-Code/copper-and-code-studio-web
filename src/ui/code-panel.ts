// The Code tab, as upstream's ui/code/editor.py CodePanel: the Object and Procedure lists, the
// signature line, the editor with "What do you want to do?" (ActionHelper) beside it, the errors
// of what is open. The logic is in src/app/code.ts.
import { LitElement, css, html, nothing } from 'lit';
import { type CodeController, keyId } from '../app/code.ts';
import { tr } from '../i18n/tr.ts';
import type { CodeEditor, CompletionProvider } from './code-editor.ts';
import './code-editor.ts';

export class CodePanel extends LitElement {
  static override properties = {
    controller: { attribute: false },
    running: { type: Boolean },
    revision: { state: true },
    search: { state: true },
    collapsed: { state: true },
  };

  controller: CodeController | null = null;
  running = false;
  revision = 0;
  provider: CompletionProvider = () => [];
  onStop: () => void = () => {};
  private unsubscribe: (() => void) | null = null;
  private shown = '';
  search = '';
  /** ActionHelper: the groups closed by the user, by title. */
  collapsed = new Set<string>();

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
      height: 100%;
      min-height: 0;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    select,
    button {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
    }
    select {
      min-width: 12rem;
      flex: 1 1 auto;
    }
    button:disabled {
      color: var(--muted);
    }
    button:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .work {
      flex: 1 1 auto;
      min-height: 120px;
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(160px, 1fr);
      gap: 6px;
    }
    @media (max-width: 900px) {
      .work {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(120px, 1fr) minmax(80px, 30%);
      }
    }
    lms-code-editor {
      min-height: 120px;
    }
    .signature {
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
      background: var(--bg);
      padding: 4px 6px;
      border-radius: 4px;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .helper {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
      overflow: auto;
    }
    .helper h3 {
      font-size: 0.95rem;
      margin: 0;
    }
    .helper input {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
    }
    .helper ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .helper ul ul {
      padding-left: 12px;
    }
    .helper button {
      border: none;
      background: none;
      text-align: left;
      width: 100%;
      padding: 1px 4px;
      cursor: pointer;
    }
    .helper .group {
      font-weight: bold;
    }
    option.exists {
      font-weight: bold;
    }
    .running {
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--bg);
      padding: 4px 8px;
      border-radius: 4px;
    }
    .hint {
      color: var(--muted);
      font-size: 0.85rem;
      margin: 0;
    }
    .errors {
      color: var(--danger);
      white-space: pre-wrap;
      margin: 0;
      font-size: 0.9rem;
    }
  `;

  get editor(): CodeEditor | null {
    return this.renderRoot.querySelector('lms-code-editor');
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('controller')) {
      this.unsubscribe?.();
      this.unsubscribe = this.controller?.onChange(() => this.revision++) ?? null;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  override updated(): void {
    const editor = this.editor;
    const controller = this.controller;
    if (!editor || !controller) return;
    editor.provider = this.provider;
    editor.onChange = (text) => controller.edit(text);
    editor.readOnly = this.running;
    const id = keyId(controller.current);
    const text = controller.text();
    if (id !== this.shown) {
      this.shown = id;
      editor.setText(text);
    } else if (editor.text !== text) {
      editor.replaceText(text); // undo, redo or a reload changed it
    }
    editor.showErrors(
      controller
        .errors()
        .map((error) => error.sourceLine ?? 0)
        .filter(Boolean),
    );
  }

  /** ActionHelper._filter: a group shows when its title or one of its actions matches. */
  private renderHelper() {
    const controller = this.controller;
    if (!controller) return nothing;
    const needle = this.search.trim().toLowerCase();
    const groups = controller.actions
      .map((group) => {
        const titleMatch = needle !== '' && group.title.toLowerCase().includes(needle);
        const actions = group.actions.filter(
          (action) => !needle || titleMatch || action.label.toLowerCase().includes(needle),
        );
        return { ...group, actions };
      })
      .filter((group) => group.actions.length);
    return html`<div class="helper" aria-label=${tr('What do you want to do?')} role="region">
      <h3>${tr('What do you want to do?')}</h3>
      <input
        type="search"
        aria-label=${tr('Search an object or action')}
        placeholder=${tr('Search an object or action')}
        .value=${this.search}
        @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
      />
      <ul role="tree" aria-label=${tr('What do you want to do?')} data-testid="actions">
        ${groups.map((group) => {
          const open = needle
            ? true
            : this.collapsed.has(group.title)
              ? false
              : group.expanded || this.opened.has(group.title);
          return html`<li role="none">
            <button
              type="button"
              class="group"
              role="treeitem"
              aria-expanded=${String(open)}
              @click=${() => this.toggleGroup(group.title, open)}
            >
              ${group.title}
            </button>
            ${
              open
                ? html`<ul role="group">
                    ${group.actions.map(
                      (action) =>
                        html`<li role="none">
                          <button
                            type="button"
                            role="treeitem"
                            title=${action.code.replace('§', '')}
                            data-code=${action.code}
                            ?disabled=${this.running}
                            @dblclick=${() => this.editor?.insertCode(action.code)}
                            @keydown=${(event: KeyboardEvent) => {
                              if (event.key === 'Enter') this.editor?.insertCode(action.code);
                            }}
                          >
                            ${action.label}
                          </button>
                        </li>`,
                    )}
                  </ul>`
                : nothing
            }
          </li>`;
        })}
      </ul>
      <p class="hint">${tr('Double-click to insert the code')}</p>
    </div>`;
  }

  /** The groups the user opened, besides those the helper opens itself. */
  private opened = new Set<string>();

  private toggleGroup(title: string, open: boolean): void {
    const collapsed = new Set(this.collapsed);
    if (open) {
      collapsed.add(title);
      this.opened.delete(title);
    } else {
      collapsed.delete(title);
      this.opened.add(title);
    }
    this.collapsed = collapsed;
  }

  /** Opens a line, from the Errors panel. */
  async goToLine(line: number): Promise<void> {
    await this.updateComplete;
    this.editor?.goToLine(line);
  }

  override render() {
    const controller = this.controller;
    if (!controller) return nothing;
    const current = keyId(controller.current);
    const module = controller.current.kind === 'pymodule';
    const errors = controller.errors();
    return html`
      <div class="row">
        <label for="code-object">${tr('Object')}</label>
        <select
          id="code-object"
          data-testid="code-object"
          data-capture="code.object"
          .value=${controller.object}
          @change=${(event: Event) =>
            void controller.selectObject((event.target as HTMLSelectElement).value)}
        >
          ${controller.objects.map(
            (object) =>
              html`<option value=${object.key} ?selected=${object.key === controller.object}>
                ${object.label}
              </option>`,
          )}
        </select>
        <label for="code-procedure">${tr('Procedure')}</label>
        <select
          id="code-procedure"
          data-testid="code-procedure"
          data-capture="code.procedure"
          .value=${current.startsWith('handler:') ? current.slice(8) : (controller.procedures[0]?.handler ?? '')}
          @change=${(event: Event) =>
            void controller.selectProcedure((event.target as HTMLSelectElement).value)}
        >
          ${controller.procedures.map(
            (procedure) =>
              html`<option
                value=${procedure.handler}
                class=${procedure.exists ? 'exists' : ''}
                ?selected=${current === `handler:${procedure.handler}`}
              >
                ${procedure.event}${procedure.exists ? '' : ''}
              </option>`,
          )}
        </select>
      </div>
      <div class="row">
        <button
          type="button"
          data-capture="code.new-python-module"
          ?disabled=${this.running}
          @click=${() => void controller.newModule()}
        >
          ${tr('New Python Module…')}
        </button>
        <button
          type="button"
          data-capture="code.rename-module"
          ?disabled=${this.running || !module}
          @click=${() => void controller.renameModule()}
        >
          ${tr('Rename Module…')}
        </button>
        <button
          type="button"
          data-capture="code.delete-module"
          ?disabled=${this.running || !module}
          @click=${() => void controller.deleteModule()}
        >
          ${tr('Delete Module')}
        </button>
      </div>
      <p class="signature" data-testid="code-signature">${controller.signature}</p>
      ${
        this.running
          ? html`<div class="running" role="status">
              <span>${tr('The simulator is running: the code can be read but not changed.')}</span>
              <button type="button" @click=${() => this.onStop()}>${tr('Stop and Edit')}</button>
            </div>`
          : nothing
      }
      <div class="work">
        <lms-code-editor label=${tr('Code')} data-capture="code-editor"></lms-code-editor>
        ${this.renderHelper()}
      </div>
      ${
        module
          ? html`<p class="hint">
              ${tr(
                'A module does not get ui and lv the way handlers do: import them at the top, with import ui and import lvgl as lv. From handlers and the general code, use it with import followed by its name.',
              )}
            </p>`
          : nothing
      }
      ${
        errors.length
          ? html`<p class="errors" data-testid="code-errors" role="alert">
              ${errors.map((error) => error.message).join('\n')}
            </p>`
          : nothing
      }
    `;
  }
}

customElements.define('lms-code-panel', CodePanel);

declare global {
  interface HTMLElementTagNameMap {
    'lms-code-panel': CodePanel;
  }
}
