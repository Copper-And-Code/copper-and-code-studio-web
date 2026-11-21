import { captureOptions } from '../capture/options.ts';
import { capture } from '../capture/hub.ts';
import { LitElement, css, html, nothing } from 'lit';
import type { CenterTab, Studio } from '../app/studio.ts';
import { type MappedError, captureFile } from '../app/code.ts';
import { upstream } from '../build-info.ts';
import { tr } from '../i18n/tr.ts';
import type { PythonBridge, PythonState } from '../py/bridge.ts';
import type { DocState } from '../project/session.ts';
import type { Location } from '../storage/store.ts';
import { upstreamLabel } from '../upstream.ts';
import type { Dialogs } from './dialogs.ts';
import './dialogs.ts';
import type { Menu } from './menu-bar.ts';
import './menu-bar.ts';
import type { SimPanel } from './sim-panel.ts';
import './sim-panel.ts';
import type { SimState } from '../sim/simulator.ts';
import type { CodeEditor } from './code-editor.ts';
import './code-editor.ts';
import type { CodePanel } from './code-panel.ts';
import './code-panel.ts';
import './files-panel.ts';
import type { DesignerView } from './designer-view.ts';
import './designer-view.ts';
import './project-tree.ts';
import './properties-panel.ts';
import './toolbox.ts';
import type { DeviceConsole } from './device-console.ts';
import './device-console.ts';
import type { UploadProgress } from './upload-progress.ts';
import './upload-progress.ts';
import type { DeviceView } from '../app/device.ts';
import { BOARD_STORE } from '../board/board-store.ts';

const BOARD_ROOT = { store: BOARD_STORE, path: '' };
import { WIDGET_MIME } from './designer-view.ts';
import type { TreeKey } from './project-tree.ts';

const OUTPUT_LIMIT = 100_000;
type BottomTab = 'output' | 'errors' | 'components' | 'device';

/** The IDE window: menu bar, the three working areas, the status bar, the dialogs. */
export class AppShell extends LitElement {
  static override properties = {
    python: { attribute: false },
    studio: { attribute: false },
    pythonState: { state: true },
    doc: { state: true },
    statusMessage: { state: true },
    tab: { state: true },
    outputText: { state: true },
    running: { state: true },
    bottom: { state: true },
    workbench: { state: true },
    design: { state: true },
    deviceStatus: { state: true },
    applyUpdate: { state: true },
  };

  python: PythonBridge | undefined;
  studio: Studio | undefined;
  pythonState: PythonState | undefined;
  doc: DocState | undefined;
  statusMessage = '';
  tab: CenterTab = 'code';
  outputText = '';
  /** Counts the changes of the designer, to draw its canvases again. */
  design = 0;
  running = false;
  bottom: BottomTab = 'output';
  /** The board's connection, in the status bar (device_status). */
  deviceStatus = '';
  /** A new version of the IDE is cached: reloads into it (src/pwa/pwa.ts). */
  applyUpdate: (() => void) | null = null;
  /** Counts the changes of the studio's tabs, files and errors, to render them again. */
  workbench = 0;
  private errorCount = 0;
  private unsubscribe: (() => void)[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  static override styles = css`
    :host {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) minmax(70px, 22vh) auto;
      height: 100vh;
      height: 100dvh;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
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
    .center {
      display: flex;
      flex-direction: column;
      padding-top: 4px;
    }
    [role='tablist'] {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }
    [role='tab'] {
      font: inherit;
      color: var(--muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 4px 12px;
      cursor: pointer;
    }
    [role='tab'][aria-selected='true'] {
      color: var(--text);
      border-bottom-color: var(--accent);
    }
    [role='tab']:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    [role='tabpanel'] {
      flex: 1 1 auto;
      min-height: 0;
    }
    [role='tabpanel'][hidden] {
      display: none;
    }
    /* the demonstration board: its screen, and a line that says it is no hardware */
    #panel-demo-board {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px;
      background: #101318;
      color: #e6e8eb;
    }
    #panel-demo-board[hidden] {
      display: none;
    }
    .demo-note {
      margin: 0;
      font-size: 13px;
    }
    .demo-screen {
      flex: 1 1 auto;
      min-height: 0;
    }
    .demo-screen iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    /* the column does not grow with its contents: each part scrolls inside its own share, and
       the board's row stays at the bottom, in sight */
    .left {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .left > div {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    /* the Toolbox gives way down to a few rows, never to nothing */
    .left > .toolbox {
      flex: 0 1 auto;
      min-height: 130px;
    }
    /* the title, the project's details, and its tree, which gets what is left but never less
       than two rows; contain: size keeps the tree's contents out of the section's own minimum
       (WebKit counted the whole tree in it, and pushed the board's row out of the window) */
    .left > .project {
      flex: 3 1 0;
      min-height: auto;
    }
    .left > .project lms-project-tree {
      flex: 1 1 auto;
      min-height: 48px;
      contain: size;
      overflow: auto;
      /* as the Toolbox: a box whose contents scroll, with a clear edge */
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px;
      background: var(--bg);
    }
    .left > .project dl {
      margin-bottom: 6px;
    }
    .left > .files {
      flex: 2 1 0;
      min-height: auto;
    }
    lms-files-panel {
      flex: 1 1 auto;
      min-height: 60px;
    }
    lms-files-panel.board-files {
      flex: 0 1 auto;
      max-height: 50%;
      min-height: 0;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .center [role='tablist'] {
      flex-wrap: wrap;
    }
    .page-panel lms-designer-view {
      height: 100%;
    }
    /* where the designer's previews run: drawn, but not seen and not in the way */
    .preview-host {
      position: fixed;
      left: 0;
      top: 0;
      width: 1px;
      height: 1px;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }
    .preview-host iframe {
      border: none;
    }
    .toolbox lms-toolbox {
      max-height: 30vh;
      flex: 0 1 auto;
      min-height: 0;
    }
    footer .update {
      color: var(--text);
    }
    footer .update button {
      font: inherit;
      padding: 0 8px;
      margin-left: 4px;
    }
    .budget.level-1 {
      color: #b26a00;
    }
    .budget.level-2 {
      color: var(--danger);
      font-weight: bold;
    }
    .components {
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 4px;
    }
    .components [role='option'] {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 10px;
      cursor: pointer;
    }
    .components [role='option'][aria-selected='true'] {
      background: var(--selection);
    }
    .components [role='option']:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .file-tab {
      display: inline-flex;
      align-items: center;
    }
    .file-tab .close {
      font: inherit;
      color: var(--muted);
      background: none;
      border: none;
      border-radius: 4px;
      padding: 0 4px;
      cursor: pointer;
    }
    .file-tab .close:hover,
    .file-tab .close:focus-visible {
      color: var(--text);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .file-panel {
      display: flex;
      flex-direction: column;
      gap: 6px;
      height: 100%;
      min-height: 0;
    }
    .file-panel lms-code-editor {
      flex: 1 1 auto;
      min-height: 120px;
    }
    .notice {
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--bg);
      padding: 4px 8px;
      border-radius: 4px;
    }
    .syntax {
      color: var(--danger);
      white-space: pre-wrap;
      margin: 0;
      font-size: 0.9rem;
    }
    .errors-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    .errors-table th {
      text-align: left;
      color: var(--muted);
      font-weight: normal;
    }
    .errors-table td,
    .errors-table th {
      padding: 2px 8px 2px 0;
    }
    .errors-table button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      text-align: left;
    }
    .errors-table button:focus-visible {
      outline: 2px solid var(--accent);
    }
    .bottom-tabs {
      display: flex;
      gap: 2px;
    }
    .output {
      border-top: 1px solid var(--border);
      background: var(--panel);
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 4px 12px;
    }
    .output [role='tab'] {
      padding: 2px 10px;
    }
    .output [role='tabpanel'] {
      overflow: auto;
    }
    .output lms-device-console {
      flex: 1 1 auto;
      min-height: 0;
      padding-top: 4px;
    }
    .output pre {
      flex: 1 1 auto;
      margin: 0;
      overflow: auto;
      font:
        12px ui-monospace,
        'SFMono-Regular',
        Menlo,
        Consolas,
        monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
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
        grid-template-rows: auto minmax(320px, 1fr) auto;
        overflow: auto;
      }
      section {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
    }
  `;

  /** Where the demonstration board shows its display (src/board/demo-board.ts). */
  get demoScreen(): HTMLElement {
    const host = this.renderRoot.querySelector<HTMLElement>('.demo-screen');
    if (!host) throw new Error('The shell is not rendered yet');
    return host;
  }

  /**
   * lmsCapture.editor(): the editor the centre shows and what it holds: general (the Code tab's
   * general code), handler:<name>, module:<name>, or file:<path> for a file tab.
   */
  shownEditor(): { file: string; editor: CodeEditor } | null {
    const studio = this.studio;
    if (!studio) return null;
    if (this.tab === 'code') {
      const editor = this.renderRoot.querySelector<CodePanel>('lms-code-panel')?.editor;
      if (!editor) return null;
      const current = studio.code.current;
      return { file: captureFile(current, studio.code.moduleName(current)), editor };
    }
    if (this.tab.startsWith('file:')) {
      const id = this.tab.slice(5);
      const tab = studio.files.get(Number(id));
      const editor = this.renderRoot.querySelector<CodeEditor>(
        `lms-code-editor[data-file="${CSS.escape(id)}"]`,
      );
      return tab && editor ? { file: `file:${tab.location.path}`, editor } : null;
    }
    return null;
  }

  /** Every editor of the shell, for lmsCapture.idle(). */
  editors(): CodeEditor[] {
    const code = this.renderRoot.querySelector<CodePanel>('lms-code-panel')?.editor;
    return [
      ...(code ? [code] : []),
      ...this.renderRoot.querySelectorAll<CodeEditor>('lms-code-editor[data-file]'),
    ];
  }

  /** The canvas of a page, for lmsCapture.widgetBox. */
  designerView(pageId: string): DesignerView | null {
    return this.renderRoot.querySelector<DesignerView>(
      `lms-designer-view[page-id="${CSS.escape(pageId)}"]`,
    );
  }

  get simPanel(): SimPanel {
    const panel = this.renderRoot.querySelector('lms-sim-panel');
    if (!panel) throw new Error('The shell is not rendered yet');
    return panel;
  }

  /** The Simulator tab and the Output panel, as the run controller sees them. */
  runView() {
    const panel = this.simPanel;
    return {
      output: (text: string) => this.appendOutput(text),
      terminal: (text: string) => panel.write(text),
      clearTerminal: () => panel.clear(),
      focusTerminal: () => panel.focusTerminal(),
      state: (state: SimState, program: boolean) => this.simState(state, program),
      status: (message: string) => {
        if (message) this.showStatus(message);
      },
    };
  }

  private appendOutput(text: string): void {
    this.outputText = (this.outputText + text).slice(-OUTPUT_LIMIT);
    void this.updateComplete.then(() => {
      const pre = this.renderRoot.querySelector('.output pre');
      if (pre) pre.scrollTop = pre.scrollHeight;
    });
  }

  private simState(state: SimState, program: boolean): void {
    const panel = this.simPanel;
    this.running = state === 'starting' || state === 'running';
    if (this.running) {
      this.studio?.show('simulator');
      panel.program = program;
    }
    const doc = this.doc;
    switch (state) {
      case 'starting':
        panel.status = tr('Starting {target} simulator…', { target: 'MicroPython' });
        break;
      case 'running':
        panel.status = program
          ? tr('Program running')
          : `${doc?.display.width ?? ''}×${doc?.display.height ?? ''} RGB565`;
        break;
      case 'ended':
        panel.status = tr('Simulator finished ({code})', { code: 0 });
        break;
      case 'failed':
        panel.status = tr('Simulator not started');
        break;
      case 'stopped':
        panel.status = tr('Simulator stopped');
        break;
    }
  }

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
        this.unsubscribe.push(
          studio.onWorkbench(() => {
            this.tab = studio.tab;
            // ui/main_run.py raises the Errors panel when rows arrive
            if (studio.errors.length > this.errorCount) this.bottom = 'errors';
            this.errorCount = studio.errors.length;
            this.workbench++;
          }),
        );
        studio.output = (text) => this.appendOutput(text);
        refresh();
        void this.updateComplete.then(() => {
          if (!studio.designer) {
            const host = this.renderRoot.querySelector<HTMLElement>('.preview-host');
            if (host) {
              const designer = studio.attachDesigner(host);
              this.unsubscribe.push(designer.onChange(() => this.design++));
              this.requestUpdate();
            }
          }
          if (!studio.run) {
            const run = studio.attachRun(this.runView(), this.simPanel.screen);
            this.simPanel.onType = (data) => run.type(data);
            this.requestUpdate();
          }
          if (!studio.device) {
            const device = studio.attachDevice(this.deviceView(), this.demoScreen);
            this.deviceConsole.onKeys = (data) => device.write(data);
            this.deviceConsole.onCancel = () => device.cancel();
          }
        });
      }
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  /** For src/pwa/pwa.ts: the IDE works offline now. */
  offlineReady(): void {
    this.showStatus(
      tr('The IDE is saved in this browser: it opens without the network too.'),
      8000,
    );
  }

  private showStatus(message: string, ms = 3000): void {
    this.statusMessage = message;
    clearTimeout(this.statusTimer);
    if (ms) this.statusTimer = setTimeout(() => (this.statusMessage = ''), ms);
  }

  /** FilesPanel's BoardFilesView: the files of the connected board, read when connected. */
  private renderBoardFiles() {
    const studio = this.studio;
    const device = studio?.device;
    if (!studio || !device?.available) return nothing;
    const connected = device.connected;
    return html`<lms-files-panel
      class="board-files"
      .name=${'board-files'}
      .store=${connected ? (studio.stores.get(BOARD_STORE) ?? null) : null}
      .folder=${connected ? BOARD_ROOT : null}
      .heading=${
        connected
          ? tr('Board on {port}', { port: device.port?.label ?? '' })
          : tr('Board: not connected')
      }
      .chooseLabel=${tr('Refresh')}
      .chooseDisabled=${!connected}
      .revision=${studio.boardRevision}
      .onOpen=${(location: Location) => void studio.openFile(location)}
      .menuFor=${(entry: { location: Location; kind: 'file' | 'folder' } | null) =>
        studio.boardFilesMenu(entry)}
      .onChooseFolder=${() => studio.refreshBoardFiles()}
      .onSelect=${(path: string, kind: 'file' | 'folder') => studio.selectBoardEntry(path, kind)}
    ></lms-files-panel>`;
  }

  private get deviceConsole(): DeviceConsole {
    const panel = this.renderRoot.querySelector('lms-device-console');
    if (!panel) throw new Error('The shell is not rendered yet');
    return panel;
  }

  /** The Device Console, the upload's window and the status bar, as the board sees them. */
  private deviceView(): DeviceView {
    const console = this.deviceConsole;
    const progress = this.renderRoot.querySelector('lms-upload-progress') as UploadProgress;
    return {
      append: (text) => console.write(text),
      message: (text) => console.message(text),
      setReady: (ready, reason) => {
        console.ready = ready;
        console.reason = reason;
      },
      setBusy: (busy) => (console.busy = busy),
      status: (text, ms = 3000) => this.showStatus(text, ms),
      connection: (text) => (this.deviceStatus = text),
      raise: () => (this.bottom = 'device'),
      focusConsole: () => void this.updateComplete.then(() => console.focusTerminal()),
      progress: {
        open: (rate, cancel) => {
          capture.emit('upload-started', {});
          progress.open(rate, cancel);
        },
        report: (sent, total, name, size) => {
          capture.emit('upload-progress', { sent, total, name, size });
          progress.report(sent, total, name, size);
        },
        rate: () => progress.rate(),
        finish: () => {
          capture.emit('upload-finished', {});
          progress.finish();
        },
      },
    };
  }

  private pythonStatus(): string {
    const state = this.pythonState;
    switch (state?.stage) {
      case undefined:
      case 'loading-python':
        return tr('Python: starting…');
      case 'loading-upstream':
        return tr('Python: loading Copper and Code Studio…');
      case 'ready':
        // capture mode: no time in the text, so two captures show the same status bar
        if (captureOptions.enabled)
          return tr('Python {version} ready', { version: state.info.python });
        return tr('Python {version} ready in {seconds} s', {
          version: state.info.python,
          seconds: (state.info.startMs / 1000).toFixed(1),
        });
      case 'failed':
        return tr('Python failed to start: {error}', { error: state.error.message });
    }
  }

  private menus(): Menu[] {
    const help: Menu = {
      label: tr('Help'),
      items: () => [
        { label: tr('About Copper and Code Studio'), id: 'about', action: () => this.openAbout() },
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

  private simPanelProgram(): boolean {
    return this.renderRoot.querySelector('lms-sim-panel')?.program ?? false;
  }

  private tabId(tab: CenterTab): string {
    return tab.replace(':', '-');
  }

  private renderTab(tab: CenterTab, label: string) {
    const selected = this.tab === tab;
    return html`<button
      type="button"
      role="tab"
      id="tab-${this.tabId(tab)}"
      data-testid="tab-${this.tabId(tab)}"
      data-capture="tab-${this.tabId(tab)}"
      aria-controls="panel-${this.tabId(tab)}"
      aria-selected=${selected ? 'true' : 'false'}
      tabindex=${selected ? 0 : -1}
      @click=${() => this.studio?.show(tab)}
    >
      ${label}
    </button>`;
  }

  private centerTabs(): CenterTab[] {
    const pages = this.doc?.pages.map((page) => `page:${page.id}` as CenterTab) ?? [];
    const files = this.studio?.files.tabs.map((tab) => `file:${tab.id}` as CenterTab) ?? [];
    const demo: CenterTab[] = this.studio?.device?.demo ? ['demo-board'] : [];
    return [...pages, 'code', 'simulator', ...demo, ...files];
  }

  private renderPagePanels() {
    const designer = this.studio?.designer;
    if (!designer || !this.doc) return nothing;
    return this.doc.pages.map((page) => {
      const id = this.tabId(`page:${page.id}`);
      return html`<div
        role="tabpanel"
        class="page-panel"
        id="panel-${id}"
        aria-labelledby="tab-${id}"
        ?hidden=${this.tab !== `page:${page.id}`}
      >
        <lms-designer-view
          page-id=${page.id}
          .controller=${designer}
          .revision=${this.design}
          .onActivate=${(name: string) => void this.studio?.openHandler(name)}
        ></lms-designer-view>
      </div>`;
    });
  }

  private tabKeys(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (!(event.target as HTMLElement).matches('[role="tab"]')) return;
    const tabs = this.centerTabs();
    const index = tabs.indexOf(this.tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (!next) return;
    this.studio?.show(next);
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>(`#tab-${this.tabId(next)}`)?.focus(),
    );
    event.preventDefault();
  }

  private renderFileTabs() {
    const studio = this.studio;
    if (!studio) return nothing;
    return studio.files.tabs.map(
      (tab) =>
        html`<span class="file-tab">
          ${this.renderTab(`file:${tab.id}`, studio.files.title(tab))}
          <button
            type="button"
            class="close"
            aria-label=${tr('Close {name}', { name: studio.files.title(tab) })}
            title=${tr('Close')}
            @click=${() => void studio.closeFile(tab.id)}
          >
            ×
          </button>
        </span>`,
    );
  }

  private renderFilePanels() {
    const studio = this.studio;
    if (!studio) return nothing;
    return studio.files.tabs.map((tab) => {
      const id = this.tabId(`file:${tab.id}`);
      return html`<div
        role="tabpanel"
        class="file-panel"
        id="panel-${id}"
        aria-labelledby="tab-${id}"
        ?hidden=${this.tab !== `file:${tab.id}`}
      >
        ${
          tab.notice
            ? html`<div class="notice" role="status">
                <span>${tab.notice}</span>
                ${
                  tab.offerReload
                    ? html`<button type="button" @click=${() => void studio.files.reload(tab)}>
                        ${tr('Reload')}
                      </button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        <lms-code-editor
          data-capture="file-editor"
          data-file=${tab.id}
          label=${tab.location.path}
          .provider=${(qualified: string) =>
            tab.location.path.endsWith('.py') ? studio.lvCompletions(qualified) : []}
        ></lms-code-editor>
        ${
          tab.errors.length
            ? html`<p class="syntax" data-testid="file-errors" role="alert">
                ${tab.errors
                  .map((error) => `${tr('Line')} ${error.line}: ${error.message}`)
                  .join('\n')}
              </p>`
            : nothing
        }
      </div>`;
    });
  }

  override updated(): void {
    const studio = this.studio;
    if (!studio) return;
    // the editors of file tabs: their text, their errors, their changes
    for (const editor of this.renderRoot.querySelectorAll<CodeEditor>(
      'lms-code-editor[data-file]',
    )) {
      const tab = studio.files.get(Number(editor.dataset.file));
      if (!tab) continue;
      if (editor.dataset.version !== String(tab.version)) {
        editor.dataset.version = String(tab.version);
        editor.setText(tab.text);
      }
      editor.onChange = (text) => studio.files.edit(tab, text);
      editor.showErrors(tab.errors.map((error) => error.line));
    }
    const code = this.renderRoot.querySelector<CodePanel>('lms-code-panel');
    if (code && studio.run) code.onStop = () => void studio.run?.stop();
  }

  private async openErrorRow(error: MappedError): Promise<void> {
    const line = await this.studio?.openError(error);
    if (line == null) return;
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<CodePanel>('lms-code-panel')?.goToLine(line),
    );
  }

  private renderErrors() {
    const errors = this.studio?.errors ?? [];
    if (!errors.length) return html`<p class="placeholder">${tr('No errors')}</p>`;
    return html`<table class="errors-table" data-testid="errors">
      <thead>
        <tr>
          <th>${tr('File')}</th>
          <th>${tr('Line')}</th>
          <th>${tr('Message')}</th>
        </tr>
      </thead>
      <tbody>
        ${errors.map((error) => {
          const name = error.file ? error.file.split('/').pop() : tr('Compiler');
          return html`<tr title=${error.tooltip ?? ''}>
            <td>${name}</td>
            <td>${error.sourceLine ?? error.line}</td>
            <td>
              <button type="button" @click=${() => void this.openErrorRow(error)}>
                ${error.message}
              </button>
            </td>
          </tr>`;
        })}
      </tbody>
    </table>`;
  }

  /**
   * The tree's pages come from the document, at once, as the old list of pages did; the widgets
   * of each from the designer, which reads them a moment later.
   */
  private projectTree(doc: DocState) {
    const tree = this.studio?.designer?.tree ?? { pages: [], components: [] };
    return {
      components: tree.components,
      pages: doc.pages.map((page) => ({
        id: page.id,
        name: page.name,
        widgets: tree.pages.find((item) => item.id === page.id)?.widgets ?? [],
      })),
    };
  }

  /** ComponentTray.dragEnterEvent: only components are taken. */
  private readonly componentDragOver = (event: DragEvent) => {
    const designer = this.studio?.designer;
    const type = designer?.dragging;
    if (!type || !event.dataTransfer?.types.includes(WIDGET_MIME)) return;
    if (designer.isComponent(type)) event.preventDefault();
  };

  /** ComponentTray.dropEvent: the component goes to the first page, as on the desktop. */
  private readonly componentDrop = (event: DragEvent) => {
    const designer = this.studio?.designer;
    const type = designer?.dragging;
    const first = this.doc?.pages[0]?.id;
    if (!designer || !type || !first || !designer.isComponent(type)) return;
    event.preventDefault();
    void designer.addWidget(first, type, 0, 0, null, false);
  };

  /** ComponentTray: the non-visual components; a click selects, a double click opens the handler. */
  private renderComponents() {
    const designer = this.studio?.designer;
    const components = designer?.tree.components ?? [];
    if (!components.length) return html`<p class="placeholder">${tr('No components')}</p>`;
    const selected = new Set(designer?.properties ?? []);
    const names = () =>
      (designer?.properties ?? []).filter((name) => components.some((c) => c.name === name));
    return html`<ul
      @keydown=${(event: KeyboardEvent) => {
        // ComponentTray.keyPressEvent: Delete removes the components selected
        if (event.key === 'Delete' && names().length) {
          event.preventDefault();
          void designer?.deleteComponents(names());
        }
      }}
      class="components"
      role="listbox"
      aria-multiselectable="true"
      aria-label=${tr('Components')}
    >
      ${components.map(
        (component) =>
          html`<li
            role="option"
            tabindex="0"
            data-testid="component"
            aria-selected=${String(selected.has(component.name))}
            title=${component.type}
            @click=${(event: MouseEvent) => {
              const names =
                event.ctrlKey || event.metaKey
                  ? [
                      ...(designer?.properties.filter((name) =>
                        components.some((c) => c.name === name),
                      ) ?? []),
                      component.name,
                    ]
                  : [component.name];
              designer?.selectComponents(names);
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === 'Enter' && component.events)
                void this.studio?.openHandler(component.name);
              else if (event.key === ' ') {
                event.preventDefault();
                designer?.selectComponents([component.name]);
              }
            }}
            @dblclick=${() => component.events && void this.studio?.openHandler(component.name)}
          >
            ${component.name}
          </li>`,
      )}
    </ul>`;
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
      <lms-project-tree
        data-capture="project-tree"
        .tree=${this.projectTree(doc)}
        .modules=${doc.modules}
        .selected=${this.studio?.treeSelected ?? null}
        .onSelect=${(key: TreeKey) => this.studio?.treeSelect(key)}
        .onActivate=${(key: TreeKey) => this.studio?.treeActivate(key)}
        .menuFor=${(key: TreeKey | null) => this.studio?.treeMenu(key) ?? []}
      ></lms-project-tree>
    `;
  }

  override render() {
    const label = upstreamLabel(upstream);
    return html`
      <header>
        <h1 class="visually-hidden">Copper and Code Studio Web</h1>
        <lms-menu-bar label=${tr('Main menu')} .menus=${this.menus()}></lms-menu-bar>
      </header>
      <main>
        <section class="left" aria-label=${tr('Project tree')}>
          <div class="toolbox">
            <h2>${tr('Toolbox')}</h2>
            <lms-toolbox
              .controller=${this.studio?.designer ?? null}
              .revision=${this.design}
            ></lms-toolbox>
          </div>
          <div class="project">
            <h2>${tr('Project')}</h2>
            ${this.renderProject()}
          </div>
          <div class="files">
            <h2>${tr('Files')}</h2>
            <lms-files-panel
              .store=${this.studio?.filesFolder ? (this.studio.stores.get(this.studio.filesFolder.store) ?? null) : null}
              .folder=${this.studio?.filesFolder ?? null}
              .revision=${this.workbench}
              .onOpen=${(location: Location) => void this.studio?.openFile(location)}
              .menuFor=${(entry: { location: Location; kind: 'file' | 'folder' } | null) =>
                this.studio?.filesMenu(entry) ?? []}
              .onChooseFolder=${() => void this.studio?.chooseFilesFolder()}
            ></lms-files-panel>
            ${this.renderBoardFiles()}
          </div>
        </section>
        <section class="center" aria-label=${tr('Editor')}>
          <div role="tablist" @keydown=${this.tabKeys}>
            ${this.doc?.pages.map((page) => this.renderTab(`page:${page.id}`, page.name)) ?? nothing}
            ${this.renderTab('code', tr('Code'))} ${this.renderTab('simulator', tr('Simulator'))}
            ${this.studio?.device?.demo ? this.renderTab('demo-board', tr('Demo board (simulated)')) : nothing}
            ${this.renderFileTabs()}
          </div>
          ${this.renderPagePanels()}
          <div
            role="tabpanel"
            id="panel-code"
            aria-labelledby="tab-code"
            ?hidden=${this.tab !== 'code'}
          >
            <lms-code-panel
              .controller=${this.studio?.code ?? null}
              .provider=${(qualified: string) => this.studio?.codeEntries(qualified) ?? []}
              ?running=${this.running && !this.simPanelProgram()}
            ></lms-code-panel>
          </div>
          <div
            role="tabpanel"
            id="panel-simulator"
            aria-labelledby="tab-simulator"
            ?hidden=${this.tab !== 'simulator'}
          >
            <lms-sim-panel></lms-sim-panel>
          </div>
          <div
            role="tabpanel"
            id="panel-demo-board"
            aria-labelledby="tab-demo-board"
            ?hidden=${this.tab !== 'demo-board'}
          >
            <p class="demo-note" role="note">
              ${tr(
                'A simulated board, not hardware: it runs what the IDE uploads, with the same MicroPython as the simulator, and behaves as the board of the project.',
              )}
            </p>
            <div class="demo-screen" data-capture="demo-board-screen"></div>
          </div>
          ${this.renderFilePanels()}
        </section>
        <section aria-label=${tr('Properties')}>
          <h2>${tr('Properties')}</h2>
          <lms-properties-panel
            .controller=${this.studio?.designer ?? null}
            .revision=${this.design}
            .onEvent=${(widget: string, event: string) => void this.studio?.openEvent(widget, event)}
          ></lms-properties-panel>
        </section>
      </main>
      <section class="output" aria-label=${tr('Output and Errors')}>
        <div role="tablist" class="bottom-tabs">
          ${(['output', 'errors', 'components', 'device'] as const).map(
            (tab) =>
              html`<button
                type="button"
                role="tab"
                id="bottom-${tab}"
                data-testid="bottom-${tab}"
                aria-controls="bottom-panel-${tab}"
                aria-selected=${String(this.bottom === tab)}
                tabindex=${this.bottom === tab ? 0 : -1}
                @click=${() => (this.bottom = tab)}
              >
                ${
                  tab === 'output'
                    ? tr('Output')
                    : tab === 'components'
                      ? tr('Components')
                      : tab === 'device'
                        ? tr('Device Console')
                        : `${tr('Errors')}${this.studio?.errors.length ? ` (${this.studio.errors.length})` : ''}`
                }
              </button>`,
          )}
        </div>
        <pre
          role="tabpanel"
          id="bottom-panel-output"
          aria-labelledby="bottom-output"
          data-testid="output"
          data-capture="output"
          tabindex="0"
          ?hidden=${this.bottom !== 'output'}
        >
${this.outputText}</pre>
        <div
          role="tabpanel"
          id="bottom-panel-errors"
          aria-labelledby="bottom-errors"
          ?hidden=${this.bottom !== 'errors'}
        >
          ${this.renderErrors()}
        </div>
        <div
          role="tabpanel"
          id="bottom-panel-components"
          aria-labelledby="bottom-components"
          ?hidden=${this.bottom !== 'components'}
          @dragover=${this.componentDragOver}
          @drop=${this.componentDrop}
        >
          ${this.renderComponents()}
        </div>
        <lms-device-console
          role="tabpanel"
          id="bottom-panel-device"
          aria-labelledby="bottom-device"
          ?hidden=${this.bottom !== 'device'}
        ></lms-device-console>
      </section>
      <footer>
        <span>${this.statusMessage || `Copper and Code Studio ${label}`}</span>
        ${
          this.studio?.budgetText
            ? html`<span
                class="budget level-${this.studio.budgetText.level}"
                data-testid="budget"
                data-capture="budget"
                title=${this.studio.budgetText.tooltip}
                >${this.studio.budgetText.text}</span
              >`
            : nothing
        }
        ${
          this.deviceStatus
            ? html`<span data-testid="device-status">${this.deviceStatus}</span>`
            : nothing
        }
        ${
          this.applyUpdate
            ? html`<span class="update" data-testid="update" role="status"
                >${tr('A new version of the IDE is ready.')}
                <button type="button" @click=${() => this.applyUpdate?.()}>
                  ${tr('Reload')}
                </button></span
              >`
            : nothing
        }
        <span data-testid="python-status" data-capture="python-status" role="status"
          >${this.pythonStatus()}</span
        >
      </footer>
      <lms-upload-progress></lms-upload-progress>
      <lms-dialogs></lms-dialogs>
      <div class="preview-host" aria-hidden="true"></div>
      <dialog id="about" aria-labelledby="about-title">
        <h1 id="about-title">Copper and Code Studio Web</h1>
        <p>${tr('The visual GUI builder for MicroPython and LVGL, in the browser.')}</p>
        <p>${tr('Upstream:')} <strong data-testid="upstream-tag">${label}</strong></p>
        <p>
          Python:
          <span data-testid="python-version"
            >${
              this.pythonState?.stage === 'ready'
                ? `${this.pythonState.info.python} (Pyodide ${this.pythonState.info.pyodide})`
                : tr('not ready yet')
            }</span
          >
        </p>
        <p>${tr('Licence: {licence}', { licence: 'GPL-3.0-or-later' })}</p>
        <p>
          ${tr(
            'Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.',
          )}
        </p>
        <form method="dialog">
          <button type="submit" @click=${this.closeAbout}>${tr('Close')}</button>
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
