// The Simulator tab, as upstream's ui/sim_panel.py: the screen, and under it, for a program
// without pages, the terminal that is its serial port. The status line says what runs.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { LitElement, css, html, unsafeCSS } from 'lit';
import { tr } from '../i18n/tr.ts';

export class SimPanel extends LitElement {
  static override properties = {
    program: { type: Boolean, reflect: true },
    status: { state: true },
  };

  /** The element the simulator puts its iframe in. */
  readonly screen = document.createElement('div');
  program = false;
  status = tr('Simulator stopped');
  private terminal: Terminal | null = null;
  private readonly fit = new FitAddon();
  private observer: ResizeObserver | null = null;
  private written = '';
  /** Keys typed in the terminal. */
  onType: (data: string) => void = () => {};

  static override styles = [
    unsafeCSS(xtermCss),
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        gap: 6px;
      }
      .screen {
        flex: 3 1 0;
        min-height: 120px;
        background: #101318;
        border-radius: 4px;
        overflow: hidden;
      }
      .screen iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
      }
      .terminal {
        display: none;
        flex: 2 1 0;
        min-height: 80px;
        background: #000;
        padding: 4px;
        border-radius: 4px;
        overflow: hidden;
      }
      :host([program]) .terminal {
        display: block;
      }
      .status {
        color: var(--muted);
        font-size: 0.85rem;
      }
    `,
  ];

  constructor() {
    super();
    this.screen.className = 'screen';
    this.screen.dataset.testid = 'sim-screen';
  }

  override firstUpdated(): void {
    const host = this.renderRoot.querySelector<HTMLElement>('.terminal');
    if (!host) return;
    const terminal = new Terminal({
      convertEol: true, // a board's print ends lines with LF; the desktop terminal adds the CR
      cursorBlink: true,
      fontSize: 13,
      scrollback: 2000,
      theme: { background: '#000000' },
    });
    terminal.loadAddon(this.fit);
    terminal.open(host);
    terminal.onData((data) => this.onType(data));
    this.terminal = terminal;
    this.observer = new ResizeObserver(() => {
      if (this.program) this.fit.fit();
    });
    this.observer.observe(host);
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('program') && this.program) {
      requestAnimationFrame(() => this.fit.fit());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
  }

  write(text: string): void {
    this.written = (this.written + text).slice(-200_000);
    this.terminal?.write(text);
  }

  clear(): void {
    this.written = '';
    this.terminal?.reset();
  }

  focusTerminal(): void {
    this.terminal?.focus();
  }

  /** What the terminal received, as text: for tests. */
  get text(): string {
    return this.written;
  }

  override render() {
    return html`
      ${this.screen}
      <div class="terminal" data-testid="sim-terminal" aria-label=${tr('Terminal')}></div>
      <div class="status" role="status" data-testid="sim-status">${this.status}</div>
    `;
  }
}

customElements.define('lms-sim-panel', SimPanel);

declare global {
  interface HTMLElementTagNameMap {
    'lms-sim-panel': SimPanel;
  }
}
