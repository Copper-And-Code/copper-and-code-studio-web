// The Code tab: what to edit, the editor, the errors of what is open. The logic is in
// src/app/code.ts; the texts are upstream's (ui/code/editor.py).
import { LitElement, css, html, nothing } from 'lit';
import { type CodeController, keyId, parseKey } from '../app/code.ts';
import { tr } from '../i18n/tr.ts';
import type { CodeEditor, CompletionProvider } from './code-editor.ts';
import './code-editor.ts';

export class CodePanel extends LitElement {
  static override properties = {
    controller: { attribute: false },
    running: { type: Boolean },
    revision: { state: true },
  };

  controller: CodeController | null = null;
  running = false;
  revision = 0;
  provider: CompletionProvider = () => [];
  onStop: () => void = () => {};
  private unsubscribe: (() => void) | null = null;
  private shown = '';

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
    lms-code-editor {
      flex: 1 1 auto;
      min-height: 120px;
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

  /** Opens a line, from the Errors panel. */
  async goToLine(line: number): Promise<void> {
    await this.updateComplete;
    this.editor?.goToLine(line);
  }

  override render() {
    const controller = this.controller;
    if (!controller) return nothing;
    const state = controller.state;
    const current = keyId(controller.current);
    const module = controller.current.kind === 'pymodule';
    const errors = controller.errors();
    return html`
      <div class="row">
        <label for="code-select">${tr('Code')}</label>
        <select
          id="code-select"
          data-testid="code-select"
          .value=${current}
          @change=${(event: Event) =>
            controller.select(parseKey((event.target as HTMLSelectElement).value))}
        >
          <option value="module" ?selected=${current === 'module'}>${tr('(General)')}</option>
          ${
            state.handlers.length
              ? html`<optgroup label=${tr('Handlers')}>
                  ${state.handlers.map(
                    (h) =>
                      html`<option
                        value="handler:${h.name}"
                        ?selected=${current === `handler:${h.name}`}
                      >
                        ${h.name}
                      </option>`,
                  )}
                </optgroup>`
              : nothing
          }
          ${
            state.modules.length
              ? html`<optgroup label=${tr('Modules')}>
                  ${state.modules.map(
                    (m) =>
                      html`<option
                        value="pymodule:${m.id}"
                        ?selected=${current === `pymodule:${m.id}`}
                      >
                        ${m.name}.py
                      </option>`,
                  )}
                </optgroup>`
              : nothing
          }
        </select>
        <button type="button" ?disabled=${this.running} @click=${() => void controller.newModule()}>
          ${tr('New Python Module…')}
        </button>
        <button
          type="button"
          ?disabled=${this.running || !module}
          @click=${() => void controller.renameModule()}
        >
          ${tr('Rename Module…')}
        </button>
        <button
          type="button"
          ?disabled=${this.running || !module}
          @click=${() => void controller.deleteModule()}
        >
          ${tr('Delete Module')}
        </button>
      </div>
      ${
        this.running
          ? html`<div class="running" role="status">
              <span>${tr('The simulator is running: the code can be read but not changed.')}</span>
              <button type="button" @click=${() => this.onStop()}>${tr('Stop and Edit')}</button>
            </div>`
          : nothing
      }
      <lms-code-editor label=${tr('Code')}></lms-code-editor>
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
