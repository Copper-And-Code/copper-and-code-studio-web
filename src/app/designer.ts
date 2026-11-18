// The page designer, as upstream's ui/main_window.py runs it: one canvas per page, the Real LVGL
// Preview (ui/designer/preview.py) of the page shown, the grid, the zoom and Fit to Window, the
// resolution (ui/main_resolution.py, ui/resolution.py). What a page holds comes from Python
// (py/lms_bridge.py design_page): the canvas draws it as ui/designer/scene.py does.
import { html } from 'lit';
import { live } from 'lit/directives/live.js';
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

/** The project tree's part of the project (ui/main_tree.py) and the Components strip. */
export interface DesignTree {
  pages: {
    id: string;
    name: string;
    widgets: { name: string; type: string; component: boolean }[];
  }[];
  components: { name: string; type: string; events: boolean }[];
}

/** A row of the Properties panel: ui/properties/panel.py rebuild. */
export interface PropertyRow {
  name: string;
  label: string;
  type: string;
  value: string;
  checked?: boolean;
  descriptor: { name: string; type?: string; options?: string[]; min?: number; max?: number };
}

export interface PropertiesView {
  names: string[];
  categories: { name: string; label: string; rows: PropertyRow[] }[];
  events: { event: string; description: string; handler: string; bound: boolean }[];
  /** The fonts of the project, offered for a font property. */
  fonts: string[];
}

export interface ToolboxCategory {
  category: string;
  label: string;
  entries: { type: string; name: string; component: boolean }[];
}

/** A widget's geometry while it is dragged or resized, not yet in the project. */
export type Geometry = { x: number; y: number; width: number; height: number };

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
  tree: DesignTree = { pages: [], components: [] };
  /** What each canvas has selected, by widget name, as each DesignerScene keeps its own. */
  private readonly selections = new Map<string, string[]>();
  /** The widgets the Properties panel shows: PropertiesPanel.set_selection. */
  properties: string[] = [];
  /** What the Properties panel shows of them. */
  propertiesView: PropertiesView = { names: [], categories: [], events: [], fonts: [] };
  /** The panel's message: a value refused, or the warnings of a rename. */
  propertiesMessage = '';
  private viewTicket = 0;
  /** Toolbox._arm_views: the widget the next click on a page places; null when none. */
  armed: string | null = null;
  /** The widget type the Toolbox is dragging: a drag's data cannot be read until it is dropped. */
  dragging: string | null = null;
  private toolboxEntries: Promise<ToolboxCategory[]> | null = null;
  private readonly renderer: PreviewRenderer;

  /** No page being drawn or about to be: for lmsCapture.idle(). */
  get idle(): boolean {
    return this.renderer.idle;
  }
  private readonly listeners = new Set<() => void>();
  private loading = Promise.resolve();
  /** How many times the pages were read again after a change: for tests that wait for one. */
  revisionCount = 0;

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
      this.tree = await this.python.call<DesignTree>('design_tree');
      // DesignerScene.rebuild keeps the selection by name; PropertiesPanel drops names gone
      const names = new Set(this.tree.pages.flatMap((page) => page.widgets.map((w) => w.name)));
      for (const [id, selected] of this.selections) {
        const page = this.pages.get(id);
        const here = new Set(page?.widgets.map((widget) => widget.name) ?? []);
        this.selections.set(
          id,
          selected.filter((name) => here.has(name)),
        );
      }
      this.properties = this.properties.filter((name) => names.has(name));
      await this.loadProperties();
      this.fitIfResized();
      this.revisionCount++;
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

  // ---- selection: ui/designer/scene.py, ui/main_tree.py _tree_selection ----

  selected(pageId: string): string[] {
    return this.selections.get(pageId) ?? [];
  }

  /** The canvas's selection changed: selectionNamesChanged → PropertiesPanel.set_selection. */
  select(pageId: string, names: string[]): void {
    const unique = [...new Set(names)];
    const before = this.selected(pageId);
    if (before.length === unique.length && before.every((name, i) => name === unique[i])) return;
    this.selections.set(pageId, unique);
    this.setProperties(unique);
  }

  /** PropertiesPanel.set_selection, then rebuild. */
  private setProperties(names: string[]): void {
    this.properties = names; // the message stays until the next change, as on the desktop
    this.changed();
    void this.loadProperties().then(() => this.changed());
  }

  private async loadProperties(): Promise<void> {
    const ticket = ++this.viewTicket;
    const view = await this.python.call<PropertiesView>('properties_view', this.properties);
    if (ticket === this.viewTicket) this.propertiesView = view;
  }

  /**
   * PropertiesPanel._item_changed: a value typed or chosen, for every widget shown; a new name for
   * one. The canvas keeps the widget selected under its new name.
   */
  async setProperty(name: string, text: string, checked?: boolean): Promise<void> {
    const result = await this.python.call<{
      error: string | null;
      warnings: string[];
      names: string[];
      state: DocState;
    }>('properties_set', this.properties, name, text, checked ?? null);
    if (name === 'Name' && result.names.length === 1 && this.properties.length === 1) {
      const [old] = this.properties;
      const [renamed] = result.names;
      for (const [id, selected] of this.selections) {
        this.selections.set(
          id,
          selected.map((item) => (item === old ? (renamed ?? item) : item)),
        );
      }
    }
    this.properties = result.names;
    this.propertiesMessage = result.error ?? result.warnings.join('\n');
    this.session.adopt(result.state);
    await this.loadProperties();
    this.changed();
  }

  /** ComponentTray._selection_changed: components only reach the Properties panel. */
  selectComponents(names: string[]): void {
    if (!names.length) return;
    this.setProperties(names);
  }

  /** Edit → Select All, on the canvas shown: DesignerScene.select_all. */
  selectAll(pageId = this.active): void {
    const page = pageId ? this.pages.get(pageId) : undefined;
    if (page)
      this.select(
        page.id,
        page.widgets.map((widget) => widget.name),
      );
  }

  /** The page a widget is on, from the tree. */
  pageOf(name: string): string | null {
    return this.tree.pages.find((page) => page.widgets.some((w) => w.name === name))?.id ?? null;
  }

  // ---- editing: ui/designer/scene.py ----

  toolbox(): Promise<ToolboxCategory[]> {
    this.toolboxEntries ??= this.python.call<ToolboxCategory[]>('toolbox').then((categories) => {
      for (const category of categories)
        for (const entry of category.entries)
          if (entry.component) this.componentTypes.add(entry.type);
      return categories;
    });
    return this.toolboxEntries;
  }

  /** MainWindow._blocks_changed: the Toolbox, the canvases and Properties read the blocks again. */
  blocksChanged(): void {
    this.toolboxEntries = null;
    this.componentTypes.clear();
    this.blocksRevision++;
    void this.refresh();
  }

  /** Grows when the blocks change: the Toolbox reads its entries again. */
  blocksRevision = 0;

  /** Whether a type of the Toolbox is a component: it has no place on a page. */
  isComponent(widgetType: string): boolean {
    return this.componentTypes.has(widgetType);
  }

  private readonly componentTypes = new Set<string>();

  /** DesignerView.arm_widget, for every page. */
  arm(widgetType: string | null): void {
    this.armed = widgetType;
    this.changed();
  }

  /** A change made: the project as Python has it, the canvases rebuilt, then what to select. */
  private async adopt(state: DocState, pageId?: string | null, select?: string[]): Promise<void> {
    this.session.adopt(state);
    await this.loading; // the refresh the change started: the new widgets are on the page
    if (pageId && select) this.select(pageId, select);
  }

  /** DesignerScene.add_widget: inside the container under the point, then selected. */
  async addWidget(
    pageId: string,
    widgetType: string,
    x: number,
    y: number,
    parentId: string | null,
    centered: boolean,
  ): Promise<void> {
    const result = await this.python.call<{ created: string[]; state: DocState }>(
      'design_add_widget',
      pageId,
      widgetType,
      x,
      y,
      parentId,
      centered,
      this.gridSize,
    );
    await this.adopt(result.state, pageId, result.created);
  }

  /** The size of a new widget, for the drop preview; null for a component. */
  defaultWidget(
    widgetType: string,
  ): Promise<{ name: string; props: Record<string, unknown> } | null> {
    return this.python.call('design_default_size', widgetType);
  }

  async deleteSelected(pageId = this.active): Promise<void> {
    if (!pageId || !this.selected(pageId).length) return;
    await this.adopt(await this.python.call<DocState>('design_delete', this.selected(pageId)));
  }

  /** The Delete key on the Components strip. */
  async deleteComponents(names: string[]): Promise<void> {
    if (names.length) await this.adopt(await this.python.call<DocState>('design_delete', names));
  }

  /** The arrow keys: move_selected. */
  async moveSelected(dx: number, dy: number, pageId = this.active): Promise<void> {
    if (!pageId || !this.selected(pageId).length) return;
    await this.adopt(
      await this.python.call<DocState>('design_move', this.selected(pageId), dx, dy),
    );
  }

  /** commit_items: the end of a drag or a resize. */
  async commitGeometry(changed: Record<string, Geometry>): Promise<void> {
    if (!Object.keys(changed).length) return;
    await this.adopt(await this.python.call<DocState>('design_geometry', changed));
  }

  /** _preview_drag: while dragging, the real frame follows the widgets. */
  previewDrag(pageId: string, pending: Record<string, Geometry>): void {
    const page = this.pages.get(pageId);
    if (!this.previewOn || !page || !Object.keys(pending).length) return;
    this.renderer.request(pageId, page.key, pending);
  }

  async copy(cut = false, pageId = this.active): Promise<void> {
    if (!pageId) return;
    const state = await this.python.call<DocState>(
      'design_copy',
      pageId,
      this.selected(pageId),
      cut,
    );
    if (cut) await this.adopt(state);
  }

  async paste(pageId = this.active): Promise<void> {
    if (!pageId) return;
    const result = await this.python.call<{ created: string[]; state: DocState }>(
      'design_paste',
      pageId,
    );
    if (result.created.length) await this.adopt(result.state, pageId, result.created);
  }

  async duplicate(pageId = this.active): Promise<void> {
    if (!pageId || !this.selected(pageId).length) return;
    const result = await this.python.call<{ created: string[]; state: DocState }>(
      'design_duplicate',
      pageId,
      this.selected(pageId),
    );
    await this.adopt(result.state, pageId, result.created);
  }

  async align(side: string, pageId = this.active): Promise<void> {
    if (!pageId) return;
    await this.adopt(
      await this.python.call<DocState>('design_align', pageId, this.selected(pageId), side),
    );
  }

  async distribute(axis: 'horizontal' | 'vertical', pageId = this.active): Promise<void> {
    if (!pageId) return;
    await this.adopt(
      await this.python.call<DocState>('design_distribute', pageId, this.selected(pageId), axis),
    );
  }

  async changeZ(front: boolean, pageId = this.active): Promise<void> {
    if (!pageId || !this.selected(pageId).length) return;
    await this.adopt(
      await this.python.call<DocState>('design_z', pageId, this.selected(pageId), front),
    );
  }

  /** Arrange → Adapt Page to Resolution…: adapt_current_page. */
  async adaptPage(pageId: string | null): Promise<boolean> {
    if (!pageId || this.blocked()) return false;
    const plan = await this.python.call<{
      designSize: [number, number] | null;
      display: Size;
    }>('adapt_page_plan', pageId);
    if (!plan.designSize) return false;
    const [width, height] = plan.designSize;
    const mode = await this.resizeMode(plan.display, false, '', { width, height });
    if (mode === null) return false;
    const result = await this.python.call<{ outside: string[]; state: DocState }>(
      'doc_adapt_page',
      pageId,
      mode,
    );
    await this.adopt(result.state);
    if (result.outside.length) {
      this.output(
        `${tr('Widgets outside canvas: {names}', { names: result.outside.join(', ') })}\n`,
      );
    }
    return true;
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

  /**
   * select_run_target: the simulator, or a board; a board of another profile brings its
   * resolution, with the question, in the same undo step.
   */
  async selectRunTarget(kind: 'simulator' | 'board', profileId?: string): Promise<boolean> {
    const plan = await this.python.call<{
      same: boolean;
      error?: string;
      size?: Size;
    }>('run_target_plan', kind, profileId ?? null);
    if (plan.same) return true;
    if (plan.error) {
      this.error(plan.error);
      return false;
    }
    let mode: ResizeMode = 'keep';
    if (plan.size) {
      if (this.blocked()) return false;
      const chosen = await this.resizeMode(plan.size, true, '');
      if (chosen === null) return false;
      mode = chosen;
    }
    const result = await this.python.call<{ outside: string[]; state: DocState }>(
      'doc_set_run_target',
      kind,
      profileId ?? null,
      mode,
    );
    this.session.adopt(result.state);
    this.reportOutside(result.outside);
    return true;
  }

  /** Project → Project Settings…: ProjectSettingsDialog, then the question, one undo step. */
  async projectSettings(): Promise<boolean> {
    if (this.blocked()) return false;
    const view = await this.python.call<{
      presets: { width: number; height: number; label: string }[];
      profiles: { key: string; name: string; width: number; height: number; info: string }[];
      current: string | null;
      display: Size;
      diagnostics: string[];
    }>('project_settings_view');
    const form = {
      width: view.display.width,
      height: view.display.height,
      profile: view.current,
      info: view.diagnostics.join('\n'),
    };
    const profile = () => view.profiles.find((item) => item.key === form.profile);
    const sync = () => {
      // _sync_resolution: a profile fixes the resolution
      const chosen = profile();
      if (chosen) {
        form.width = chosen.width;
        form.height = chosen.height;
      }
      this.dialogs.refresh();
    };
    sync();
    const number = (value: string, fallback: number) => {
      const parsed = Math.round(Number(value));
      return Number.isFinite(parsed) ? Math.min(10000, Math.max(1, parsed)) : fallback;
    };
    const accepted = await this.dialogs.custom<boolean>(
      tr('Project Settings'),
      (finish) => html`
        <div class="grid">
          <label for="settings-preset">${tr('Preset')}</label>
          <select
            id="settings-preset"
            ?disabled=${!!profile()}
            @change=${(event: Event) => {
              const preset = view.presets[Number((event.target as HTMLSelectElement).value)];
              if (preset) {
                form.width = preset.width;
                form.height = preset.height;
              }
              this.dialogs.refresh();
            }}
          >
            <option value="">${tr('Custom')}</option>
            ${view.presets.map((preset, index) => html`<option value=${index}>${preset.label}</option>`)}
          </select>
          <span>${tr('Resolution')}</span>
          <div class="row">
            <input
              type="number"
              min="1"
              max="10000"
              aria-label=${tr('Width')}
              ?disabled=${!!profile()}
              .value=${live(String(form.width))}
              @change=${(event: Event) =>
                (form.width = number((event.target as HTMLInputElement).value, form.width))}
            />
            <input
              type="number"
              min="1"
              max="10000"
              aria-label=${tr('Height')}
              ?disabled=${!!profile()}
              .value=${live(String(form.height))}
              @change=${(event: Event) =>
                (form.height = number((event.target as HTMLInputElement).value, form.height))}
            />
          </div>
          <label for="settings-profile">${tr('Board Profile')}</label>
          <select
            id="settings-profile"
            .value=${live(form.profile ?? '')}
            @change=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              form.profile = value === '' ? null : value;
              const chosen = profile();
              if (chosen) form.info = chosen.info;
              sync();
            }}
          >
            <option value="">${tr('No Profile')}</option>
            ${view.profiles.map((item) => html`<option value=${item.key}>${item.name}</option>`)}
          </select>
        </div>
        ${form.info ? html`<p data-testid="settings-info">${form.info}</p>` : ''}
        <div class="buttons">
          <button type="button" @click=${() => finish(false)}>${tr('Cancel')}</button>
          <button type="button" class="primary" @click=${() => finish(true)}>${tr('Apply')}</button>
        </div>
      `,
      false,
    );
    if (!accepted) return false;
    const mode = await this.resizeMode({ width: form.width, height: form.height }, true, '');
    if (mode === null) return false;
    const result = await this.python.call<{ outside: string[]; state: DocState }>(
      'doc_project_settings',
      form.width,
      form.height,
      form.profile,
      mode,
    );
    await this.adopt(result.state);
    this.reportOutside(result.outside);
    return true;
  }

  /** Project → Update Project Profile: the project's copy of its board from the catalog. */
  async updateProjectProfile(): Promise<boolean> {
    const result = await this.python.call<{ error: string | null; state: DocState }>(
      'doc_update_profile',
    );
    if (result.error) {
      this.error(result.error);
      return false;
    }
    await this.adopt(result.state);
    return true;
  }

  private reportOutside(outside: string[]): void {
    if (outside.length) {
      this.output(`${tr('Widgets outside canvas: {names}', { names: outside.join(', ') })}\n`);
    }
  }

  /**
   * The … button of an image or font property: the file becomes part of the project and the
   * property names it, in one undo step (PropertiesPanel._item_changed with a file chosen).
   */
  async setPropertyFile(name: string, kind: 'image' | 'font', file: File): Promise<void> {
    let data: Uint8Array;
    try {
      const display = this.session.state?.display ?? { width: 1024, height: 600 };
      data =
        kind === 'image'
          ? await pictureAsPng(file, display)
          : new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      this.propertiesMessage = error instanceof Error ? error.message : String(error);
      this.changed();
      return;
    }
    const path = await this.python.call<string>('asset_upload_path');
    await this.python.writeFile(path, data);
    const result = await this.python.call<{
      error: string | null;
      warnings: string[];
      names: string[];
      state: DocState;
    }>('properties_set_asset', this.properties, name, kind, file.name);
    this.propertiesMessage = result.error ?? '';
    this.session.adopt(result.state);
    await this.loadProperties();
    this.changed();
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

/**
 * PropertiesPanel._read_image: a picture the browser can read, as PNG, made no larger than the
 * screen with its proportions kept.
 */
export async function pictureAsPng(
  file: File,
  display: { width: number; height: number },
): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(tr('{file} is not a picture this program can read', { file: file.name }));
  }
  let { width, height } = bitmap;
  if (width > display.width || height > display.height) {
    const scale = Math.min(display.width / width, display.height / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context)
    throw new Error(tr('{file} is not a picture this program can read', { file: file.name }));
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob)
    throw new Error(tr('{file} is not a picture this program can read', { file: file.name }));
  return new Uint8Array(await blob.arrayBuffer());
}
