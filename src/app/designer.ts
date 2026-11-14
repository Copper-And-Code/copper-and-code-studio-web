// The page designer, as upstream's ui/main_window.py runs it: one canvas per page, the Real LVGL
// Preview (ui/designer/preview.py) of the page shown, the grid, the zoom and Fit to Window, the
// resolution (ui/main_resolution.py, ui/resolution.py). What a page holds comes from Python
// (py/lms_bridge.py design_page): the canvas draws it as ui/designer/scene.py does.
import { tr } from '../i18n/tr.ts';
import type { PythonBridge } from '../py/bridge.ts';
import type { DocState, ProjectSession } from '../project/session.ts';
import type { Settings } from '../storage/settings.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import { type Preview, PreviewRenderer } from './preview.ts';

export interface DesignWidget {
  id: string;
  name: string;
  type: string;
  /** The container, when it is on the page: the widget's x and y are relative to it. */
  parentId: string | null;
  props: Record<string, unknown>;
}

export interface DesignPage {
  id: string;
  name: string;
  index: number;
  display: { width: number; height: number };
  designSize: [number, number] | null;
  /** In the order of DesignerScene.rebuild: a container before what it holds. */
  widgets: DesignWidget[];
  key: string;
}

interface Size {
  width: number;
  height: number;
}

export interface ResolutionMenu {
  boards: { width: number; height: number; names: string[] }[];
  common: Size[];
  current: Size;
}

export type ResizeMode = 'adapt' | 'stretch' | 'keep';

const PREVIEW_KEY = 'designer/preview';
const MODE_KEY = 'resolution/mode'; // ui/resolution.py MODE_KEY
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

/** What a canvas keeps of itself, as a QGraphicsView does: its scale, the size it was fitted to. */
export interface ViewState {
  zoom: number;
  fittedSize: string;
  /** Set by Fit to Window: the canvas fits itself when it has its size. */
  fit: boolean;
}

export class DesignerController {
  readonly pages = new Map<string, DesignPage>();
  /** The last frame of each page: shown only while its size is the project's. */
  readonly previews = new Map<string, Preview>();
  readonly views = new Map<string, ViewState>();
  previewOn: boolean;
  grid = false;
  /** The page whose canvas is shown, or null when another tab is. */
  active: string | null = null;
  private readonly renderer: PreviewRenderer;
  private readonly listeners = new Set<() => void>();
  private loading = Promise.resolve();

  constructor(
    private readonly python: PythonBridge,
    private readonly session: ProjectSession,
    private readonly settings: Settings,
    private readonly dialogs: Dialogs,
    previewHost: HTMLElement,
    private readonly output: (text: string) => void,
    private readonly error: (text: string) => void,
    /** True while a session would be broken by a new resolution: the simulator runs. */
    private readonly sessionRunning: () => boolean,
  ) {
    this.previewOn = settings.get<boolean>(PREVIEW_KEY, true);
    this.renderer = new PreviewRenderer(python, previewHost);
    this.renderer.onRendered((preview) => {
      if (!this.previewOn) return;
      this.previews.set(preview.pageId, preview);
      this.changed();
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get state(): DocState | undefined {
    return this.session.state;
  }

  view(pageId: string): ViewState {
    let view = this.views.get(pageId);
    if (!view) {
      // _sync_designers: only a later change of resolution fits it again
      view = { zoom: 1, fittedSize: this.displaySize(), fit: false };
      this.views.set(pageId, view);
    }
    return view;
  }

  private displaySize(): string {
    const display = this.session.state?.display;
    return display ? `${display.width}x${display.height}` : '';
  }

  /** _document_changed: every page as the project has it now; the shown one drawn again. */
  refresh(): Promise<void> {
    this.loading = this.loading.then(async () => {
      const state = this.session.state;
      if (!state) return;
      const ids = new Set(state.pages.map((page) => page.id));
      for (const id of [...this.pages.keys()]) {
        if (!ids.has(id)) {
          this.pages.delete(id);
          this.previews.delete(id);
          this.views.delete(id);
        }
      }
      for (const page of state.pages) {
        this.pages.set(page.id, await this.python.call<DesignPage>('design_page', page.id));
      }
      this.fitIfResized();
      this.changed();
      this.requestPreview();
    });
    return this.loading;
  }

  /** The tab shown changed: _request_preview and _fit_if_resized for a canvas. */
  setActive(pageId: string | null): void {
    this.active = pageId;
    this.fitIfResized();
    this.requestPreview();
    this.changed();
  }

  /** _request_preview: the shown page, if the preview is on. */
  requestPreview(): void {
    const page = this.active ? this.pages.get(this.active) : undefined;
    if (!this.previewOn || !page) return;
    this.renderer.request(page.id, page.key);
  }

  /** The image the canvas shows, as DesignerScene.preview_active decides. */
  previewOf(pageId: string): Preview | null {
    const preview = this.previews.get(pageId);
    const display = this.session.state?.display;
    if (!this.previewOn || !preview?.pixels || !display) return null;
    return preview.width === display.width && preview.height === display.height ? preview : null;
  }

  /** View → Real LVGL Preview: _toggle_preview. */
  togglePreview(): void {
    this.previewOn = !this.previewOn;
    this.settings.set(PREVIEW_KEY, this.previewOn);
    this.renderer.forget();
    if (!this.previewOn) this.previews.clear();
    this.changed();
    this.requestPreview();
  }

  /** View → Grid: _toggle_grid, a grid of 8 that the moves snap to. */
  toggleGrid(): void {
    this.grid = !this.grid;
    this.changed();
  }

  get gridSize(): number {
    return this.grid ? 8 : 1;
  }

  /** Zoom In and Zoom Out: _zoom, within 0.5 and 4. */
  zoom(factor: number, pageId = this.active): void {
    if (!pageId) return;
    const view = this.view(pageId);
    const zoom = view.zoom * factor;
    if (zoom >= ZOOM_MIN && zoom <= ZOOM_MAX) {
      view.zoom = zoom;
      this.changed();
    }
  }

  /** Fit to Window: _fit_canvas. */
  fit(pageId = this.active): void {
    if (!pageId) return;
    const view = this.view(pageId);
    view.fittedSize = this.displaySize();
    view.fit = true;
    this.changed();
  }

  /** _fit_if_resized: a new resolution fits the shown page again. */
  private fitIfResized(): void {
    if (this.active && this.view(this.active).fittedSize !== this.displaySize()) this.fit();
  }

  // ---- the resolution: ui/main_resolution.py ----

  resolutionMenu(): Promise<ResolutionMenu> {
    return this.python.call<ResolutionMenu>('resolution_menu');
  }

  private blocked(): boolean {
    if (!this.sessionRunning()) return false;
    this.error(tr('Stop the session before changing the resolution or profile.'));
    return true;
  }

  /** change_resolution: the question, one undo step, the widgets left outside reported. */
  async changeResolution(width: number, height: number): Promise<boolean> {
    const display = this.session.state?.display;
    if (!display || (width === display.width && height === display.height) || this.blocked())
      return false;
    const plan = await this.python.call<{ same: boolean; note: string }>(
      'resolution_plan',
      width,
      height,
    );
    if (plan.same) return false;
    const mode = await this.resizeMode({ width, height }, true, plan.note);
    if (mode === null) return false;
    const result = await this.python.call<{ outside: string[]; state: DocState }>(
      'doc_change_resolution',
      width,
      height,
      mode,
    );
    this.session.adopt(result.state);
    if (result.outside.length) {
      this.output(
        `${tr('Widgets outside canvas: {names}', { names: result.outside.join(', ') })}\n`,
      );
    }
    return true;
  }

  /** _custom_resolution: CustomSizeDialog. */
  async customResolution(): Promise<boolean> {
    const display = this.session.state?.display;
    if (!display) return false;
    const values = await this.dialogs.form(tr('Custom Resolution'), [
      {
        kind: 'number',
        name: 'width',
        label: tr('Width'),
        min: 1,
        max: 10000,
        value: display.width,
      },
      {
        kind: 'number',
        name: 'height',
        label: tr('Height'),
        min: 1,
        max: 10000,
        value: display.height,
      },
    ]);
    if (!values) return false;
    return this.changeResolution(Number(values.width), Number(values.height));
  }

  /** _resize_mode with ResizeDialog: what happens to the widgets; null if cancelled. */
  private async resizeMode(
    size: Size,
    allowKeep: boolean,
    note: string,
    oldSize?: Size,
  ): Promise<ResizeMode | null> {
    const display = this.session.state?.display;
    const old = oldSize ?? display;
    if (!old) return null;
    if (old.width === size.width && old.height === size.height) return 'keep';
    const options: { value: ResizeMode; label: string }[] = [
      { value: 'adapt', label: tr('Adapt: keep proportions, follow edges, centre and groups') },
      { value: 'stretch', label: tr('Stretch: scale each axis on its own, the page stays full') },
    ];
    if (allowKeep) {
      options.push({
        value: 'keep',
        label: tr('Leave them where they are: adapt each page later'),
      });
    }
    const saved = this.settings.get<string>(MODE_KEY, 'adapt');
    const values = await this.dialogs.form(
      allowKeep ? tr('Change Resolution') : tr('Adapt Page to Resolution'),
      [
        {
          kind: 'note',
          text: tr('From {old} to {new}. What should happen to the widgets?', {
            old: `${old.width}×${old.height}`,
            new: `${size.width}×${size.height}`,
          }),
        },
        {
          kind: 'radio',
          name: 'mode',
          label: tr('Widgets'),
          options,
          value: options.some((option) => option.value === saved) ? saved : 'adapt',
        },
        ...(note ? [{ kind: 'note' as const, text: note }] : []),
      ],
      tr('Apply'),
    );
    if (!values) return null;
    const mode = String(values.mode) as ResizeMode;
    this.settings.set(MODE_KEY, mode);
    return mode;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
