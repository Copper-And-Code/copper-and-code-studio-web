// The Device Console, as upstream's DeviceConsole (ui/device_panel.py): a terminal that sends each
// key to the board as it is typed, Ctrl-C and Ctrl-D buttons, Clear, and Cancel operation while
// the IDE uses the board. Messages of the IDE are grey, so they are not taken for the board's.
import { captureOptions } from '../capture/options.ts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import { tr } from '../i18n/tr.ts';

export class DeviceConsole extends LitElement {
  static override properties = {
    ready: { state: true },
    busy: { state: true },
    reason: { state: true },
  };

  ready = false;
  busy = false;
  reason = '';
  private terminal: Terminal | null = null;
  private readonly fit = new FitAddon();
  private observer: ResizeObserver | null = null;
  private written = '';
  private column = 0;
  /** Bytes typed, for the board. */
  onKeys: (data: Uint8Array) => void = () => {};
  onCancel: () => void = () => {};

  static override styles = [
    unsafeCSS(xtermCss),
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        gap: 4px;
      }
      .terminal {
        flex: 1 1 0;
        min-height: 60px;
        background: #000;
        padding: 4px;
        border-radius: 4px;
        overflow: hidden;
      }
      .row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .row .grow {
        flex: 1;
      }
      .status {
        color: var(--muted);
        font-size: 0.85rem;
      }
    `,
  ];

  override firstUpdated(): void {
    const host = this.renderRoot.querySelector<HTMLElement>('.terminal');
    if (!host) return;
    const terminal = new Terminal({
      convertEol: true, // a lone LF becomes CR LF, as on a serial terminal
      cursorBlink: !captureOptions.enabled,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#000000' },
    });
    terminal.loadAddon(this.fit);
    terminal.open(host);
    const encoder = new TextEncoder();
    terminal.onData((data) => {
      if (this.ready) this.onKeys(encoder.encode(data));
    });
    this.terminal = terminal;
    this.observer = new ResizeObserver(() => {
      if (host.offsetParent !== null) this.fit.fit();
    });
    this.observer.observe(host);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
  }

  private feed(text: string): void {
    this.written = (this.written + text).slice(-200_000);
    const last = text.lastIndexOf('\n');
    this.column = last < 0 ? this.column + text.length : text.length - last - 1;
    this.terminal?.write(text);
  }

  /** What the board printed. */
  write(text: string): void {
    if (text) this.feed(text);
  }

  /** A message of the IDE, on a line of its own and in grey. */
  message(text: string): void {
    if (!text) return;
    const lead = this.column ? '\r\n' : '';
    const body = text.replace(/\n+$/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    this.feed(`${lead}\x1b[90m${body}\x1b[0m\r\n`);
  }

  clear(): void {
    this.written = '';
    this.column = 0;
    this.terminal?.reset();
  }

  focusTerminal(): void {
    this.terminal?.focus();
  }

  /** What the console received, escapes left out: for tests. */
  get text(): string {
    // eslint-disable-next-line no-control-regex
    return this.written.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private key(data: number): void {
    this.onKeys(new Uint8Array([data]));
  }

  override render() {
    return html`
      ${
        this.reason && !this.ready
          ? html`<div class="status" role="status" data-testid="device-console-status">
              ${this.reason}
            </div>`
          : nothing
      }
      <div
        class="terminal"
        data-testid="device-terminal"
        data-capture="device-console"
        aria-label=${tr('Device Console')}
      ></div>
      <div class="row">
        <button
          type="button"
          title=${tr('Stop the running program, as Ctrl-C in the terminal')}
          ?disabled=${!this.ready}
          @click=${() => this.key(0x03)}
        >
          Ctrl-C
        </button>
        <button
          type="button"
          title=${tr('Soft reset of the board from its prompt, as Ctrl-D in the terminal')}
          ?disabled=${!this.ready}
          @click=${() => this.key(0x04)}
        >
          Ctrl-D
        </button>
        <button type="button" @click=${() => this.clear()}>${tr('Clear')}</button>
        <span class="grow"></span>
        <button
          type="button"
          data-testid="device-cancel"
          ?disabled=${!this.busy}
          @click=${() => this.onCancel()}
        >
          ${tr('Cancel operation')}
        </button>
      </div>
    `;
  }
}

customElements.define('lms-device-console', DeviceConsole);

declare global {
  interface HTMLElementTagNameMap {
    'lms-device-console': DeviceConsole;
  }
}
