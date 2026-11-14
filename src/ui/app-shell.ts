import { LitElement, css, html, nothing } from 'lit';
import type { Studio } from '../app/studio.ts';
import { upstream } from '../build-info.ts';
import { tr } from '../i18n/tr.ts';
import type { PythonBridge, PythonState } from '../py/bridge.ts';
import type { DocState } from '../project/session.ts';
import { upstreamLabel } from '../upstream.ts';
import type { Dialogs } from './dialogs.ts';
import './dialogs.ts';
import type { Menu } from './menu-bar.ts';
import './menu-bar.ts';

/** The IDE window: menu bar, the three working areas, the status bar, the dialogs. */
export class AppShell extends LitElement {
  static override properties = {
    python: { attribute: false },
    studio: { attribute: false },
    pythonState: { state: true },
    doc: { state: true },
    statusMessage: { state: true },
  };

  python: PythonBridge | undefined;
  studio: Studio | undefined;
  pythonState: PythonState | undefined;
  doc: DocState | undefined;
  statusMessage = '';
  private unsubscribe: (() => void)[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      height: 100dvh;
    }
    header {
      padding: 4px 8px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    main {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 3fr minmax(200px, 1fr);
      min-height: 0;
    }
    section {
      border-right: 1px solid var(--border);
      padding: 8px 12px;
      min-width: 0;
      overflow: auto;
    }
    section:last-child {
      border-right: none;
    }
    .placeholder {
      color: var(--muted);
    }
    h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 0 0 8px;
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      margin: 0 0 12px;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      border-radius: 4px;
      padding: 3px 6px;
      width: 100%;
      text-align: left;
      cursor: pointer;
    }
    li button:hover,
    li button:focus-visible {
      background: var(--bg);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
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
    dialog button {
      font: inherit;
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

  get dialogs(): Dialogs {
    const dialogs = this.renderRoot.querySelector('lms-dialogs');
    if (!dialogs) throw new Error('The shell is not rendered yet');
    return dialogs;
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('python') || changed.has('studio')) {
      for (const stop of this.unsubscribe) stop();
      this.unsubscribe = [];
      if (this.python) {
        this.unsubscribe.push(this.python.onState((state) => (this.pythonState = state)));
      }
      const studio = this.studio;
      if (studio) {
        const refresh = () => {
          this.doc = studio.session.state;
          if (this.doc) document.title = studio.session.title();
        };
        this.unsubscribe.push(studio.session.onChange(refresh));
        this.unsubscribe.push(studio.onStatus((message) => this.showStatus(message)));
        refresh();
      }
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  private showStatus(message: string): void {
    this.statusMessage = message;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => (this.statusMessage = ''), 3000);
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

  private menus(): Menu[] {
    const help: Menu = {
      label: tr('Help'),
      items: () => [
        { label: tr('About LVGL MPY Studio'), id: 'about', action: () => this.openAbout() },
      ],
    };
    return [...(this.studio?.menus() ?? []), help];
  }

  private openAbout(): void {
    this.renderRoot.querySelector<HTMLDialogElement>('#about')?.showModal();
  }

  private closeAbout(): void {
    this.renderRoot.querySelector<HTMLDialogElement>('#about')?.close();
  }

  private renderProject() {
    const doc = this.doc;
    if (!doc) return html`<p class="placeholder">${tr('Loading…')}</p>`;
    const location = this.studio?.session.location;
    const place = location ? this.studio?.stores.get(location.store)?.label : undefined;
    return html`
      <dl data-testid="project-info">
        <dt>${tr('Project')}</dt>
        <dd data-testid="project-name">${doc.projectName}</dd>
        <dt>${tr('File')}</dt>
        <dd data-testid="project-file">
          ${location ? `${place ?? location.store}: ${location.path}` : tr('not saved')}${
            doc.modified ? ' *' : ''
          }
        </dd>
        <dt>${tr('Board')}</dt>
        <dd>${doc.board ?? tr('none')}</dd>
        <dt>${tr('Resolution')}</dt>
        <dd>${doc.display.width}×${doc.display.height}</dd>
      </dl>
      <h2>${tr('Pages')}</h2>
      <ul aria-label=${tr('Pages')}>
        ${doc.pages.map(
          (page) =>
            html`<li>
              <button
                type="button"
                title=${tr('Rename Page')}
                data-testid="page"
                @click=${() => this.studio?.renamePageDialog(page.id)}
              >
                ${page.name}
              </button>
            </li>`,
        )}
      </ul>
    `;
  }

  override render() {
    const label = upstreamLabel(upstream);
    return html`
      <header>
        <lms-menu-bar aria-label="Main menu" role="menubar" .menus=${this.menus()}></lms-menu-bar>
      </header>
      <main>
        <section aria-label="Project tree">
          <h2>${tr('Project')}</h2>
          ${this.renderProject()}
        </section>
        <section aria-label="Designer">
          <h2>Designer</h2>
          <p class="placeholder">${tr('The page designer comes in a later phase.')}</p>
        </section>
        <section aria-label="Properties"><h2>Properties</h2></section>
      </main>
      <footer>
        <span>${this.statusMessage || `LVGL MPY Studio ${label}`}</span>
        <span data-testid="python-status" role="status">${this.pythonStatus()}</span>
      </footer>
      <lms-dialogs></lms-dialogs>
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
      ${nothing}
    `;
  }
}

customElements.define('lms-app', AppShell);

declare global {
  interface HTMLElementTagNameMap {
    'lms-app': AppShell;
  }
}
