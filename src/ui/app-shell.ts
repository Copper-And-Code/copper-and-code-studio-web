import { LitElement, css, html } from 'lit';
import { upstream } from '../build-info.ts';
import type { PythonBridge, PythonState } from '../py/bridge.ts';
import { upstreamLabel } from '../upstream.ts';

const MENUS = ['File', 'Edit', 'View', 'Simulator', 'Board'] as const;

/** The IDE window: menu bar, the three working areas and the status bar. Empty for now. */
export class AppShell extends LitElement {
  static override properties = {
    python: { attribute: false },
    pythonState: { state: true },
  };

  python: PythonBridge | undefined;
  pythonState: PythonState | undefined;
  private unsubscribe: (() => void) | undefined;

  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      padding: 4px 8px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    nav button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    nav button:hover:not(:disabled),
    nav button:focus-visible {
      background: var(--bg);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    nav button:disabled {
      color: var(--muted);
      cursor: default;
    }
    main {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) 3fr minmax(200px, 1fr);
      min-height: 0;
    }
    section {
      border-right: 1px solid var(--border);
      padding: 8px 12px;
      color: var(--muted);
      min-width: 0;
      overflow: auto;
    }
    section:last-child {
      border-right: none;
    }
    h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0 0 8px;
    }
    footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 16px;
      padding: 3px 12px;
      font-size: 0.85rem;
      color: var(--muted);
      background: var(--panel);
      border-top: 1px solid var(--border);
    }
    dialog {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      max-width: min(420px, calc(100vw - 32px));
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 0.35);
    }
    dialog h1 {
      font-size: 1.15rem;
      margin: 0 0 8px;
    }
    dialog p {
      margin: 6px 0;
    }
    @media (max-width: 720px) {
      main {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr auto;
      }
      section {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
    }
  `;

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('python')) {
      this.unsubscribe?.();
      this.unsubscribe = this.python?.onState((state) => (this.pythonState = state));
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private pythonStatus(): string {
    const state = this.pythonState;
    switch (state?.stage) {
      case undefined:
      case 'loading-python':
        return 'Python: starting…';
      case 'loading-upstream':
        return 'Python: loading LVGL MPY Studio…';
      case 'ready':
        return `Python ${state.info.python} ready in ${(state.info.startMs / 1000).toFixed(1)} s`;
      case 'failed':
        return `Python failed to start: ${state.error.message}`;
    }
  }

  private openAbout(): void {
    this.renderRoot.querySelector<HTMLDialogElement>('#about')?.showModal();
  }

  private closeAbout(): void {
    this.renderRoot.querySelector<HTMLDialogElement>('#about')?.close();
  }

  override render() {
    const label = upstreamLabel(upstream);
    return html`
      <nav aria-label="Main menu">
        ${MENUS.map((name) => html`<button type="button" disabled>${name}</button>`)}
        <button type="button" @click=${this.openAbout}>About</button>
      </nav>
      <main>
        <section aria-label="Project tree"><h2>Project</h2></section>
        <section aria-label="Designer"><h2>Designer</h2></section>
        <section aria-label="Properties"><h2>Properties</h2></section>
      </main>
      <footer>
        <span>LVGL MPY Studio ${label}</span>
        <span data-testid="python-status" role="status">${this.pythonStatus()}</span>
      </footer>
      <dialog id="about" aria-labelledby="about-title">
        <h1 id="about-title">LVGL MPY Studio Web</h1>
        <p>The LVGL MPY Studio IDE in the browser.</p>
        <p>Upstream: <strong data-testid="upstream-tag">${label}</strong></p>
        <p>
          Python:
          <span data-testid="python-version"
            >${
              this.pythonState?.stage === 'ready'
                ? `${this.pythonState.info.python} (Pyodide ${this.pythonState.info.pyodide})`
                : 'not ready yet'
            }</span
          >
        </p>
        <p>Licence: GPL-3.0-or-later</p>
        <form method="dialog">
          <button type="submit" @click=${this.closeAbout}>Close</button>
        </form>
      </dialog>
    `;
  }
}

customElements.define('lms-app', AppShell);

declare global {
  interface HTMLElementTagNameMap {
    'lms-app': AppShell;
  }
}
