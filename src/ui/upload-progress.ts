// Uploading to the board, as upstream's UploadProgress (ui/device_panel.py): it appears only when
// the upload takes longer than DELAY_MS; between two reports the bar moves at the speed measured
// so far and stops just before the end of the file; Cancel asks to stop after the current command.
import { LitElement, css, html } from 'lit';
import { tr } from '../i18n/tr.ts';

const DELAY_MS = 800;
const TICK_MS = 200;
/** Bytes per second: slower than the boards measured, so the bar never runs ahead. */
const FIRST_RATE = 4000;

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    : tr('{seconds} s', { seconds: s });
}

/** The arithmetic of the dialog, apart from its window, with a clock in seconds. */
export class UploadEstimate {
  rate: number;
  private readonly started: number;
  private sent = 0;
  private total = 0;
  private size = 0;
  private fileStart = 0;
  private reported = 0;
  private first: number | null = null;
  name = '';
  cancelling = false;

  constructor(
    private readonly clock: () => number,
    rate = 0,
  ) {
    this.started = clock();
    this.rate = rate || FIRST_RATE;
  }

  report(sent: number, total: number, name: string, size: number): void {
    const now = this.clock();
    if (this.first === null) this.first = now;
    else if (sent > 0 && now > this.first) this.rate = sent / (now - this.first);
    if (name !== this.name) {
      this.name = name;
      this.fileStart = sent;
    }
    this.sent = sent;
    this.total = total;
    this.size = size;
    this.reported = now;
  }

  /** The bytes the bar shows: those reported, plus the estimate for the file being written. */
  shown(): number {
    if (!this.total) return 0;
    const limit = this.fileStart + this.size * 0.95;
    const estimate = this.sent + this.rate * (this.clock() - this.reported);
    return Math.floor(Math.max(this.sent, Math.min(limit, estimate)));
  }

  /** The bar in thousandths, or null while busy before the first report. */
  value(): number | null {
    return this.total ? Math.floor((this.shown() * 1000) / this.total) : null;
  }

  label(): string {
    return this.name ? tr('Writing {name}', { name: this.name }) : tr('Preparing…');
  }

  detail(): string {
    const elapsed = this.clock() - this.started;
    if (this.cancelling) return tr('Cancelling after the current command…');
    if (!this.total) return tr('Elapsed {time}', { time: duration(elapsed) });
    const shown = this.shown();
    let text =
      tr('{sent} of {total} kB', {
        sent: (shown / 1024).toFixed(0),
        total: (this.total / 1024).toFixed(0),
      }) +
      ' · ' +
      tr('Elapsed {time}', { time: duration(elapsed) });
    const left = (this.total - shown) / this.rate;
    if (left >= 1) text += ' · ' + tr('about {time} left', { time: duration(left) });
    return text;
  }
}

export class UploadProgress extends LitElement {
  static override properties = { tick: { state: true } };
  tick = 0;
  private estimate: UploadEstimate | null = null;
  private timer = 0;
  private showTimer = 0;
  private onCancel: () => void = () => {};

  static override styles = css`
    dialog {
      min-width: 420px;
      max-width: calc(100vw - 32px);
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    progress {
      width: 100%;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .row span {
      flex: 1;
      color: var(--muted);
      font-size: 0.85rem;
    }
  `;

  open(rate: number, cancel: () => void): void {
    this.finish();
    this.estimate = new UploadEstimate(() => performance.now() / 1000, rate);
    this.onCancel = cancel;
    this.timer = window.setInterval(() => this.tick++, TICK_MS);
    this.showTimer = window.setTimeout(() => {
      this.renderRoot.querySelector('dialog')?.showModal();
    }, DELAY_MS);
    this.tick++;
  }

  report(sent: number, total: number, name: string, size: number): void {
    this.estimate?.report(sent, total, name, size);
    this.tick++;
  }

  /** The speed measured, which the next upload to this board starts from. */
  rate(): number {
    return this.estimate?.rate ?? 0;
  }

  finish(): void {
    window.clearInterval(this.timer);
    window.clearTimeout(this.showTimer);
    this.renderRoot.querySelector('dialog')?.close();
    this.estimate = null;
  }

  private cancel(event?: Event): void {
    event?.preventDefault(); // Esc asks to stop: the window stays until the board answers
    if (this.estimate && !this.estimate.cancelling) {
      this.estimate.cancelling = true;
      this.tick++;
      this.onCancel();
    }
  }

  override render() {
    const estimate = this.estimate;
    const value = estimate?.value() ?? null;
    return html`<dialog
      aria-labelledby="upload-title"
      data-testid="upload-progress"
      @cancel=${(event: Event) => this.cancel(event)}
    >
      <h3 id="upload-title">${tr('Uploading to the board')}</h3>
      <p>${estimate?.label() ?? ''}</p>
      ${value === null ? html`<progress></progress>` : html`<progress max="1000" .value=${value}></progress>`}
      <div class="row">
        <span>${estimate?.detail() ?? ''}</span>
        <button
          type="button"
          ?disabled=${estimate?.cancelling ?? true}
          @click=${() => this.cancel()}
        >
          ${tr('Cancel')}
        </button>
      </div>
    </dialog>`;
  }
}

customElements.define('lms-upload-progress', UploadProgress);

declare global {
  interface HTMLElementTagNameMap {
    'lms-upload-progress': UploadProgress;
  }
}
