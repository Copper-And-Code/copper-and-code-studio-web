// The canvas of one page, as upstream's ui/designer/scene.py DesignerView and DesignerScene draw
// it: the page at its resolution with 40 pixels around it, the real LVGL frame when the preview
// has one of the right size, otherwise each widget painted as WidgetItem.paint does; the grid;
// the zoom, with Ctrl and the wheel too.
import { LitElement, css, html, nothing, svg, type TemplateResult } from 'lit';
import {
  type DesignPage,
  type DesignWidget,
  type DesignerController,
  type Geometry,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../app/designer.ts';
import { rgb565ToRgba } from '../app/preview.ts';
import { tr } from '../i18n/tr.ts';
import type { ContextMenu } from './context-menu.ts';
import './context-menu.ts';
import type { Menu, MenuItem } from './menu-bar.ts';
import './menu-bar.ts';

/** The type of a widget dragged from the Toolbox: ui/designer/scene.py WIDGET_MIME. */
export const WIDGET_MIME = 'application/x-lvgl-widget';
const DROP_PREVIEW_OPACITY = 0.7;

const MARGIN = 40; // DesignerScene.rebuild: setSceneRect(-40, -40, width + 80, height + 80)
const FIT_MARGIN = 8; // MainWindow._fit_canvas
const MINIMUM_SIZE = 8;
const WHEEL_FACTOR = 1.15;

/** ui/designer/scene.py THEMES: background and foreground of each kind of widget. */
const THEMES: Record<string, [string, string]> = {
  button: ['#2196F3', '#FFFFFF'],
  imagebutton: ['#2196F3', '#FFFFFF'],
  label: ['#00000000', '#000000'],
  span: ['#FFFFFF', '#000000'],
  panel: ['#F5F5F5', '#333333'],
  obj: ['#F5F5F5', '#333333'],
  slider: ['#E0E0E0', '#1976D2'],
  switch: ['#BDBDBD', '#FFFFFF'],
  checkbox: ['#FFFFFF', '#000000'],
  textarea: ['#FFFFFF', '#000000'],
  dropdown: ['#FFFFFF', '#000000'],
  roller: ['#F5F5F5', '#000000'],
  bar: ['#E0E0E0', '#4CAF50'],
  arc: ['#E0E0E0', '#FF9800'],
  chart: ['#FFFFFF', '#2196F3'],
  table: ['#FFFFFF', '#000000'],
  keyboard: ['#EEEEEE', '#222222'],
  calendar: ['#FFFFFF', '#222222'],
};

/** A colour as QColor reads it: #RGB, #RRGGBB, #AARRGGBB (alpha first) or a name. */
export function qtColor(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const parse = (candidate: string): string | null => {
    const argb = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(candidate);
    if (argb?.[1] && argb[2]) {
      const alpha = parseInt(argb[1], 16) / 255;
      const rgb = argb[2];
      return `rgb(${parseInt(rgb.slice(0, 2), 16)} ${parseInt(rgb.slice(2, 4), 16)} ${parseInt(rgb.slice(4), 16)} / ${alpha.toFixed(3)})`;
    }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)) return candidate;
    if (/^[a-z]+$/i.test(candidate) && CSS.supports('color', candidate)) return candidate;
    return null;
  };
  return (text && parse(text)) || parse(fallback) || '#000000';
}

/** The cursor of each ResizeHandle, by its index: corners and sides, clockwise from top left. */
const HANDLE_CURSORS = [
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
];

/** The Arrange menu: align, distribute, the order. */
export function arrangeItems(controller: DesignerController, page: string | null): MenuItem[] {
  const count = page ? controller.selected(page).length : 0;
  const run = (action: () => Promise<void>) => () => void action();
  const align = (label: string, side: string): MenuItem => ({
    label,
    id: `align-${side}`,
    disabled: count < 2,
    action: run(() => controller.align(side, page)),
  });
  return [
    align(tr('Align Left'), 'left'),
    align(tr('Align Center'), 'center'),
    align(tr('Align Right'), 'right'),
    align(tr('Align Top'), 'top'),
    align(tr('Align Middle'), 'middle'),
    align(tr('Align Bottom'), 'bottom'),
    { separator: true },
    {
      label: tr('Distribute Horizontally'),
      id: 'distribute-horizontal',
      disabled: count < 3,
      action: run(() => controller.distribute('horizontal', page)),
    },
    {
      label: tr('Distribute Vertically'),
      id: 'distribute-vertical',
      disabled: count < 3,
      action: run(() => controller.distribute('vertical', page)),
    },
    { separator: true },
    {
      label: tr('Bring to Front'),
      id: 'front',
      shortcut: 'Ctrl+]',
      disabled: !count,
      action: run(() => controller.changeZ(true, page)),
    },
    {
      label: tr('Send to Back'),
      id: 'back',
      shortcut: 'Ctrl+[',
      disabled: !count,
      action: run(() => controller.changeZ(false, page)),
    },
  ];
}

const number = (value: unknown, fallback: number): number => {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where each widget is on the page: x and y inside its container, as WidgetItem.rect sizes it. */
export function sceneRects(page: DesignPage): Map<string, Rect> {
  const byId = new Map(page.widgets.map((widget) => [widget.id, widget]));
  const rects = new Map<string, Rect>();
  for (const widget of page.widgets) {
    let x = 0;
    let y = 0;
    const seen = new Set<string>();
    for (let item: DesignWidget | undefined = widget; item && !seen.has(item.id);) {
      seen.add(item.id);
      x += Math.round(number(item.props.x, 0));
      y += Math.round(number(item.props.y, 0));
      item = item.parentId ? byId.get(item.parentId) : undefined;
    }
    rects.set(widget.name, {
      x,
      y,
      width: Math.max(MINIMUM_SIZE, number(widget.props.width, 100)),
      height: Math.max(MINIMUM_SIZE, number(widget.props.height, 40)),
    });
  }
  return rects;
}

const SELECTION = '#1976D2'; // WidgetItem._paint_selection, ResizeHandle.paint
const CLICK_SLOP = 3;

/** ui/designer/scene.py snapped. */
const snapped = (value: number, grid: number) =>
  grid > 1 ? Math.round(value / grid) * grid : Math.round(value);

/** The widgets in the order they are painted: a container, then what it holds, as Qt stacks them. */
function paintOrder(page: DesignPage): DesignWidget[] {
  const children = new Map<string | null, DesignWidget[]>();
  for (const widget of page.widgets) {
    const list = children.get(widget.parentId) ?? [];
    list.push(widget);
    children.set(widget.parentId, list);
  }
  const order: DesignWidget[] = [];
  const walk = (parent: string | null) => {
    for (const widget of children.get(parent) ?? []) {
      order.push(widget);
      walk(widget.id);
    }
  };
  walk(null);
  return order;
}

type Drag =
  | {
      kind: 'move';
      start: { x: number; y: number };
      origins: Map<string, Geometry>;
      moved: boolean;
    }
  | {
      kind: 'resize';
      index: number;
      id: string;
      start: { x: number; y: number };
      origin: Geometry;
    };

export class DesignerView extends LitElement {
  static override properties = {
    controller: { attribute: false },
    pageId: { attribute: 'page-id' },
    revision: { type: Number },
    resolutions: { state: true },
    band: { state: true },
    pending: { state: true },
    ghost: { state: true },
  };

  controller: DesignerController | null = null;
  pageId = '';
  revision = 0;
  /** A double click on a widget: widgetActivated, which opens its handler. */
  onActivate: (name: string) => void = () => {};
  /** The rubber band being dragged on an empty part of the page, in page coordinates. */
  private band: { x0: number; y0: number; x1: number; y1: number; base: string[] } | null = null;
  private resolutions: MenuItem[] = [];
  private drawn: unknown = null;
  /** Geometries changed by a drag or a resize, not yet in the project (pending_geometry). */
  private pending: Record<string, Geometry> = {};
  private drag: Drag | null = null;
  /** The widget under the last press. */
  private pressed: string | null = null;
  /** The widget the Toolbox drags over the page: show_drop_preview. */
  private ghost: DesignWidget | null = null;
  private readonly defaults = new Map<
    string,
    { name: string; props: Record<string, unknown> } | null
  >();

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      gap: 6px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .toolbar > button {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .toolbar > button[aria-pressed='true'] {
      background: color-mix(in srgb, var(--accent) 20%, var(--bg));
      border-color: var(--accent);
    }
    .toolbar > button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .zoom {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      min-width: 4ch;
    }
    .resolution {
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .scroller {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      background: var(--canvas);
      border-radius: 4px;
    }
    .scroller:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .stage {
      position: relative;
      margin: auto;
    }
    .scroller[data-armed] svg {
      cursor: crosshair;
    }
    canvas,
    svg {
      position: absolute;
      left: 0;
      top: 0;
    }
    canvas {
      image-rendering: pixelated;
    }
    .status {
      color: var(--muted);
      font-size: 0.85rem;
      margin: 0;
    }
  `;

  /** The page as the project has it, with the geometries being dragged. */
  private get page(): DesignPage | undefined {
    const page = this.controller?.pages.get(this.pageId);
    if (!page || !Object.keys(this.pending).length) return page;
    return {
      ...page,
      widgets: page.widgets.map((widget) =>
        this.pending[widget.id]
          ? { ...widget, props: { ...widget.props, ...this.pending[widget.id] } }
          : widget,
      ),
    };
  }

  /** WidgetItem.geometry: x and y in the container, the size at least MINIMUM_SIZE. */
  private geometry(widget: DesignWidget): Geometry {
    return {
      x: Math.round(number(widget.props.x, 0)),
      y: Math.round(number(widget.props.y, 0)),
      width: Math.round(Math.max(MINIMUM_SIZE, number(widget.props.width, 100))),
      height: Math.round(Math.max(MINIMUM_SIZE, number(widget.props.height, 40))),
    };
  }

  /** DesignerScene.item_at: the widget on top at a point of the page. */
  private itemAt(page: DesignPage, x: number, y: number): DesignWidget | null {
    const rects = sceneRects(page);
    let found: DesignWidget | null = null;
    for (const widget of paintOrder(page)) {
      const rect = rects.get(widget.name);
      if (
        rect &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      )
        found = widget;
    }
    return found;
  }

  private get zoom(): number {
    return this.controller?.view(this.pageId).zoom ?? 1;
  }

  override updated(): void {
    const controller = this.controller;
    const page = this.page;
    if (!controller || !page) return;
    const view = controller.view(this.pageId);
    const scroller = this.renderRoot.querySelector<HTMLElement>('.scroller');
    if (view.fit && scroller && scroller.clientWidth > 0) {
      view.fit = false;
      const { width, height } = page.display;
      const zoom = Math.min(
        scroller.clientWidth / (width + 2 * FIT_MARGIN),
        scroller.clientHeight / (height + 2 * FIT_MARGIN),
      );
      view.zoom = zoom > 0 ? zoom : 1;
      this.requestUpdate();
      void this.updateComplete.then(() => {
        scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
      });
    }
    this.paintFrame();
  }

  /** The real frame into the canvas: only when it is a new one. */
  private paintFrame(): void {
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>('canvas');
    const preview = this.controller?.previewOf(this.pageId) ?? null;
    if (!canvas || !preview?.pixels) {
      this.drawn = null;
      return;
    }
    if (this.drawn === preview && canvas.dataset.drawn === '1') return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    canvas
      .getContext('2d')
      ?.putImageData(rgb565ToRgba(preview.pixels, preview.width, preview.height), 0, 0);
    canvas.dataset.drawn = '1';
    this.drawn = preview;
  }

  /** A point of the event on the page, in its own pixels. */
  private scenePoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    const box = stage?.getBoundingClientRect();
    const zoom = this.zoom;
    return {
      x: (event.clientX - (box?.left ?? 0)) / zoom - MARGIN,
      y: (event.clientY - (box?.top ?? 0)) / zoom - MARGIN,
    };
  }

  private widgetAt(event: Event): string | null {
    const target = event
      .composedPath()
      .find((node): node is Element => node instanceof Element && node.hasAttribute('data-widget'));
    return target?.getAttribute('data-widget') ?? null;
  }

  /**
   * WidgetItem.mousePressEvent and QGraphicsView's RubberBandDrag: a click selects the widget,
   * Ctrl adds it; a press on the empty page starts a band that selects what it touches.
   */
  private pointerDown(event: PointerEvent): void {
    const controller = this.controller;
    const page = this.page;
    if (!controller || !page || event.button !== 0) return;
    const point = this.scenePoint(event);
    // DesignerView.mousePressEvent: the Toolbox armed a widget, this click places it
    if (controller.armed) {
      const parent = this.itemAt(page, point.x, point.y);
      void controller.addWidget(
        this.pageId,
        controller.armed,
        point.x,
        point.y,
        parent?.id ?? null,
        false,
      );
      controller.arm(null);
      return;
    }
    const handle = event
      .composedPath()
      .find((node): node is Element => node instanceof Element && node.hasAttribute('data-handle'));
    const svgElement = event.currentTarget as Element;
    if (handle) {
      // ResizeHandle.mousePressEvent
      const widget = page.widgets.find((item) => item.id === handle.getAttribute('data-id'));
      if (!widget) return;
      this.drag = {
        kind: 'resize',
        index: Number(handle.getAttribute('data-handle')),
        id: widget.id,
        start: point,
        origin: this.geometry(widget),
      };
      svgElement.setPointerCapture(event.pointerId);
      return;
    }
    const name = this.widgetAt(event);
    this.pressed = name;
    const ctrl = event.ctrlKey || event.metaKey;
    let selected = controller.selected(this.pageId);
    if (name) {
      if (!ctrl && !selected.includes(name)) controller.select(this.pageId, [name]);
      else if (ctrl && !selected.includes(name))
        controller.select(this.pageId, [...selected, name]);
      selected = controller.selected(this.pageId);
      // DesignerScene.drag_group: the selected widgets whose container is not selected
      const byName = new Map(page.widgets.map((widget) => [widget.name, widget]));
      const ids = new Set(selected.map((item) => byName.get(item)?.id));
      const group = selected
        .map((item) => byName.get(item))
        .filter(
          (widget): widget is DesignWidget => !!widget && !ids.has(widget.parentId ?? undefined),
        );
      const grabbed = byName.get(name);
      const moving = grabbed && group.includes(grabbed) ? group : grabbed ? [grabbed] : [];
      this.drag = {
        kind: 'move',
        start: point,
        origins: new Map(moving.map((widget) => [widget.id, this.geometry(widget)])),
        moved: false,
      };
      svgElement.setPointerCapture(event.pointerId);
      return;
    }
    const base = ctrl ? selected : [];
    if (!ctrl) controller.select(this.pageId, []);
    this.band = { x0: point.x, y0: point.y, x1: point.x, y1: point.y, base };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  /** WidgetItem.mouseMoveEvent and ResizeHandle.mouseMoveEvent: the geometries follow the pointer. */
  private dragMove(drag: Drag, point: { x: number; y: number }): void {
    const controller = this.controller;
    if (!controller) return;
    const grid = controller.gridSize;
    const pending: Record<string, Geometry> = {};
    if (drag.kind === 'move') {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      if (
        !drag.moved &&
        Math.abs(dx) * this.zoom < CLICK_SLOP &&
        Math.abs(dy) * this.zoom < CLICK_SLOP
      )
        return;
      drag.moved = true;
      for (const [id, origin] of drag.origins) {
        const next = {
          x: snapped(origin.x + dx, grid),
          y: snapped(origin.y + dy, grid),
          width: origin.width,
          height: origin.height,
        };
        if (next.x !== origin.x || next.y !== origin.y) pending[id] = next;
      }
    } else {
      const { origin, index } = drag;
      const dx = snapped(point.x - drag.start.x, grid);
      const dy = snapped(point.y - drag.start.y, grid);
      const left = [0, 6, 7].includes(index);
      const right = [2, 3, 4].includes(index);
      const top = [0, 1, 2].includes(index);
      const bottom = [4, 5, 6].includes(index);
      let width = left ? origin.width - dx : right ? origin.width + dx : origin.width;
      let height = top ? origin.height - dy : bottom ? origin.height + dy : origin.height;
      width = Math.max(MINIMUM_SIZE, width);
      height = Math.max(MINIMUM_SIZE, height);
      const next = {
        x: Math.round(left ? origin.x + origin.width - width : origin.x),
        y: Math.round(top ? origin.y + origin.height - height : origin.y),
        width: Math.round(width),
        height: Math.round(height),
      };
      if (
        next.x !== origin.x ||
        next.y !== origin.y ||
        next.width !== origin.width ||
        next.height !== origin.height
      )
        pending[drag.id] = next;
    }
    this.pending = pending;
    controller.previewDrag(this.pageId, pending);
  }

  private pointerMove(event: PointerEvent): void {
    if (this.drag) {
      this.dragMove(this.drag, this.scenePoint(event));
      return;
    }
    const band = this.band;
    const controller = this.controller;
    const page = this.page;
    if (!band || !controller || !page) return;
    const point = this.scenePoint(event);
    this.band = { ...band, x1: point.x, y1: point.y };
    const zoom = this.zoom;
    if (
      Math.abs(point.x - band.x0) * zoom < CLICK_SLOP &&
      Math.abs(point.y - band.y0) * zoom < CLICK_SLOP
    )
      return;
    const left = Math.min(band.x0, point.x);
    const top = Math.min(band.y0, point.y);
    const right = Math.max(band.x0, point.x);
    const bottom = Math.max(band.y0, point.y);
    const touched: string[] = [];
    // Qt.IntersectsItemShape: a widget the band touches is selected
    for (const [name, rect] of sceneRects(page)) {
      if (
        rect.x <= right &&
        rect.x + rect.width >= left &&
        rect.y <= bottom &&
        rect.y + rect.height >= top
      )
        touched.push(name);
    }
    controller.select(this.pageId, [
      ...band.base,
      ...touched.filter((name) => !band.base.includes(name)),
    ]);
  }

  /** mouseReleaseEvent: commit_items, one undo step; a click without a move changes nothing. */
  private pointerUp(): void {
    this.band = null;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const pending = this.pending;
    if (!Object.keys(pending).length) return;
    void this.controller?.commitGeometry(pending).then(() => (this.pending = {}));
  }

  // ---- the Toolbox's drag: DesignerView.dragEnterEvent, dragMoveEvent, dropEvent ----

  private dragType(event: DragEvent): string | null {
    if (!event.dataTransfer?.types.includes(WIDGET_MIME)) return null;
    return this.controller?.dragging ?? null;
  }

  private async dragOver(event: DragEvent): Promise<void> {
    const type = this.dragType(event);
    if (!type) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!this.defaults.has(type)) {
      this.defaults.set(type, null);
      this.defaults.set(type, (await this.controller?.defaultWidget(type)) ?? null);
    }
    const definition = this.defaults.get(type);
    if (!definition) return; // a component: no preview on the page
    const point = this.scenePoint(event);
    const width = number(definition.props.width, 100);
    const height = number(definition.props.height, 40);
    const grid = this.controller?.gridSize ?? 1;
    this.ghost = {
      id: '',
      name: definition.name,
      type,
      parentId: null,
      props: {
        ...definition.props,
        x: snapped(Math.max(0, point.x - width / 2), grid),
        y: snapped(Math.max(0, point.y - height / 2), grid),
      },
    };
  }

  private dragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!related || !(event.currentTarget as Element).contains(related)) this.ghost = null;
  }

  private drop(event: DragEvent): void {
    const type = this.dragType(event);
    const page = this.page;
    this.ghost = null;
    if (!type || !page) return;
    event.preventDefault();
    const point = this.scenePoint(event);
    const parent = this.itemAt(page, point.x, point.y);
    void this.controller?.addWidget(this.pageId, type, point.x, point.y, parent?.id ?? null, true);
  }

  /** DesignerView.keyPressEvent: arrows move (Shift: by 10), Delete deletes. */
  private keyDown(event: KeyboardEvent): void {
    const controller = this.controller;
    if (!controller) return;
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (!controller.selected(this.pageId).length) return;
      void controller.moveSelected(move[0], move[1], this.pageId);
    } else if (event.key === 'Delete') {
      void controller.deleteSelected(this.pageId);
    } else if (event.key === 'Escape' && controller.armed) {
      controller.arm(null);
    } else return;
    event.preventDefault();
  }

  /** DesignerView.contextMenuEvent and MainWindow._canvas_menu. */
  private contextMenu(event: MouseEvent): void {
    const controller = this.controller;
    if (!controller) return;
    const name = this.widgetAt(event);
    if (name && !controller.selected(this.pageId).includes(name)) {
      controller.select(this.pageId, [name]);
    }
    this.renderRoot
      .querySelector<ContextMenu>('lms-context-menu')
      ?.show(event, this.editItems(), tr('Designer'));
  }

  /** The canvas menu: the Edit actions, Arrange, Select All. */
  private editItems(): MenuItem[] {
    const controller = this.controller;
    if (!controller) return [];
    const page = this.pageId;
    const none = !controller.selected(page).length;
    const item = (
      label: string,
      id: string,
      action: () => unknown,
      disabled = false,
    ): MenuItem => ({
      label,
      id,
      disabled,
      action: () => void action(),
    });
    return [
      item(tr('Cut'), 'cut', () => controller.copy(true, page), none),
      item(tr('Copy'), 'copy', () => controller.copy(false, page), none),
      item(tr('Paste'), 'paste', () => controller.paste(page)),
      item(tr('Duplicate'), 'duplicate', () => controller.duplicate(page), none),
      item(tr('Delete'), 'delete', () => controller.deleteSelected(page), none),
      { separator: true },
      ...arrangeItems(controller, page),
      { separator: true },
      item(tr('Select All'), 'select-all', () => controller.selectAll(page)),
    ];
  }

  private doubleClick(event: MouseEvent): void {
    // the pointer is captured by the canvas while it may drag: the widget is the one pressed
    const name = this.widgetAt(event) ?? this.pressed;
    if (name) this.onActivate(name);
  }

  /** DesignerView.wheelEvent: Ctrl and the wheel zoom, around the point under the mouse. */
  private wheel(event: WheelEvent): void {
    if (!event.ctrlKey || !this.controller) return;
    event.preventDefault();
    const scroller = event.currentTarget as HTMLElement;
    const before = this.zoom;
    const factor = event.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
    const after = before * factor;
    if (after < ZOOM_MIN || after > ZOOM_MAX) return;
    const box = scroller.getBoundingClientRect();
    const x = (scroller.scrollLeft + event.clientX - box.left) / before;
    const y = (scroller.scrollTop + event.clientY - box.top) / before;
    this.controller.zoom(factor, this.pageId);
    void this.updateComplete.then(() => {
      scroller.scrollLeft = x * after - (event.clientX - box.left);
      scroller.scrollTop = y * after - (event.clientY - box.top);
    });
  }

  /** ResolutionSelector.rebuild, read when the menu opens. */
  private async loadResolutions(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    const menu = await controller.resolutionMenu();
    const { width, height } = menu.current;
    const item = (size: { width: number; height: number }, label: string): MenuItem => ({
      label,
      checked: size.width === width && size.height === height,
      action: () => void controller.changeResolution(size.width, size.height),
    });
    const items: MenuItem[] = [];
    if (menu.boards.length) {
      items.push({ section: tr('Board') });
      for (const board of menu.boards) {
        items.push(item(board, `${board.width}×${board.height} — ${board.names.join(', ')}`));
      }
    }
    items.push({ section: tr('Common') });
    for (const size of menu.common) items.push(item(size, `${size.width}×${size.height}`));
    items.push({ separator: true });
    items.push({
      label: tr('Rotate ({size})', { size: `${height}×${width}` }),
      id: 'rotate',
      disabled: width === height,
      action: () => void controller.changeResolution(height, width),
    });
    items.push({
      label: tr('Custom…'),
      id: 'custom-resolution',
      action: () => void controller.customResolution(),
    });
    this.resolutions = items;
  }

  private resolutionMenu(): Menu[] {
    const display = this.page?.display;
    if (!display) return [];
    return [
      {
        label: `${display.width}×${display.height}`,
        title: tr('Project resolution'),
        onOpen: () => this.loadResolutions(),
        items: () => this.resolutions,
      },
    ];
  }

  override render() {
    const controller = this.controller;
    const page = this.page;
    if (!controller || !page) return nothing;
    const { width, height } = page.display;
    const zoom = this.zoom;
    const preview = controller.previewOf(page.id);
    const sceneWidth = width + 2 * MARGIN;
    const sceneHeight = height + 2 * MARGIN;
    const last = controller.previews.get(page.id);
    return html`
      <div class="toolbar" role="toolbar" aria-label=${tr('Designer')}>
        <button
          type="button"
          aria-pressed=${String(controller.grid)}
          @click=${() => controller.toggleGrid()}
        >
          ${tr('Grid')}
        </button>
        <button type="button" title=${tr('Zoom Out')} @click=${() => controller.zoom(0.8, page.id)}>
          −
        </button>
        <span class="zoom" data-testid="zoom">${Math.round(zoom * 100)}%</span>
        <button type="button" title=${tr('Zoom In')} @click=${() => controller.zoom(1.25, page.id)}>
          +
        </button>
        <button type="button" @click=${() => controller.fit(page.id)}>
          ${tr('Fit to Window')}
        </button>
        <lms-menu-bar
          class="resolution"
          data-testid="resolution"
          label=${tr('Project resolution')}
          .menus=${this.resolutionMenu()}
        ></lms-menu-bar>
      </div>
      <div
        class="scroller"
        tabindex="0"
        aria-label=${page.name}
        data-armed=${controller.armed ?? nothing}
        @wheel=${this.wheel}
        @keydown=${this.keyDown}
        @dragover=${(event: DragEvent) => void this.dragOver(event)}
        @dragleave=${this.dragLeave}
        @drop=${this.drop}
      >
        <div class="stage" style="width:${sceneWidth * zoom}px;height:${sceneHeight * zoom}px">
          ${
            preview
              ? html`<canvas
                  data-testid="preview"
                  data-key=${preview.key ?? ''}
                  aria-label=${tr('Real LVGL Preview')}
                  style="left:${MARGIN * zoom}px;top:${MARGIN * zoom}px;width:${width * zoom}px;height:${height * zoom}px"
                ></canvas>`
              : nothing
          }
          <svg
            @pointerdown=${this.pointerDown}
            @pointermove=${this.pointerMove}
            @pointerup=${this.pointerUp}
            @pointercancel=${this.pointerUp}
            @dblclick=${this.doubleClick}
            @contextmenu=${this.contextMenu}
            data-testid="canvas"
            viewBox="${-MARGIN} ${-MARGIN} ${sceneWidth} ${sceneHeight}"
            width=${sceneWidth * zoom}
            height=${sceneHeight * zoom}
            role="img"
            aria-label=${tr('Page {name}', { name: page.name })}
          >
            ${this.background(page, preview !== null)} ${this.items(page, preview !== null)}
            ${this.selectionLayer(page)}
          </svg>
        </div>
      </div>
      <lms-context-menu></lms-context-menu>
      ${
        controller.previewOn && last && !last.pixels
          ? html`<p class="status" data-testid="preview-problem" role="status">
              ${tr('Real LVGL Preview')}: ${lastLine(last.log) || tr('no frame from the runtime')}
            </p>`
          : nothing
      }
    `;
  }

  /** DesignerScene.drawBackground: the page white, or the frame below; the border; the grid. */
  private background(page: DesignPage, previewActive: boolean): TemplateResult {
    const { width, height } = page.display;
    const grid = Math.max(5, this.controller?.gridSize ?? 1);
    const lines: TemplateResult[] = [];
    if (this.controller?.grid) {
      for (let x = grid; x < width; x += grid)
        lines.push(svg`<line x1=${x} y1="0" x2=${x} y2=${height} />`);
      for (let y = grid; y < height; y += grid)
        lines.push(svg`<line x1="0" y1=${y} x2=${width} y2=${y} />`);
    }
    return svg`
      ${previewActive ? nothing : svg`<rect x="0" y="0" width=${width} height=${height} fill="#FFFFFF" />`}
      <rect x="0" y="0" width=${width} height=${height} fill="none" stroke="#777777" stroke-width="1" vector-effect="non-scaling-stroke" />
      ${lines.length ? svg`<g stroke="rgb(0 0 0 / 0.08)" stroke-width="1" vector-effect="non-scaling-stroke">${lines}</g>` : nothing}
    `;
  }

  /** The widgets, each inside its container as QGraphicsItem children are. */
  private items(page: DesignPage, previewActive: boolean): TemplateResult[] {
    const children = new Map<string | null, DesignWidget[]>();
    for (const widget of page.widgets) {
      const list = children.get(widget.parentId) ?? [];
      list.push(widget);
      children.set(widget.parentId, list);
    }
    const draw = (widget: DesignWidget, left: number, top: number): TemplateResult => {
      const x = Math.round(number(widget.props.x, 0));
      const y = Math.round(number(widget.props.y, 0));
      const inner = (children.get(widget.id) ?? []).map((child) => draw(child, left + x, top + y));
      const selected = this.controller?.selected(page.id).includes(widget.name) ?? false;
      return svg`<g transform="translate(${x} ${y})" data-widget=${widget.name} aria-selected=${String(selected)}>
        <title>${widget.name} (${widget.type})</title>
        ${this.paintWidget(widget, page, previewActive, left + x, top + y)}
        ${inner}
      </g>`;
    };
    return (children.get(null) ?? []).map((widget) => draw(widget, 0, 0));
  }

  /** The handles of the selected widgets, over everything, and the rubber band. */
  private selectionLayer(page: DesignPage): TemplateResult {
    const selected = new Set(this.controller?.selected(page.id) ?? []);
    const handles: TemplateResult[] = [];
    const ids = new Map(page.widgets.map((widget) => [widget.name, widget.id]));
    for (const [name, rect] of sceneRects(page)) {
      if (!selected.has(name)) continue;
      const { x, y, width, height } = rect;
      const points = [
        [x, y],
        [x + width / 2, y],
        [x + width, y],
        [x + width, y + height / 2],
        [x + width, y + height],
        [x + width / 2, y + height],
        [x, y + height],
        [x, y + height / 2],
      ];
      points.forEach(([px, py], index) => {
        handles.push(
          svg`<rect class="handle" data-handle=${index} data-id=${ids.get(name) ?? ''} x=${(px ?? 0) - 4} y=${(py ?? 0) - 4} width="8" height="8" fill="#FFFFFF" stroke=${SELECTION} stroke-width="1" pointer-events="all" style="cursor:${HANDLE_CURSORS[index] ?? 'default'}" />`,
        );
      });
    }
    const band = this.band;
    const rubber = band
      ? svg`<rect x=${Math.min(band.x0, band.x1)} y=${Math.min(band.y0, band.y1)}
          width=${Math.abs(band.x1 - band.x0)} height=${Math.abs(band.y1 - band.y0)}
          fill="rgb(25 118 210 / 0.15)" stroke=${SELECTION} stroke-width="1" vector-effect="non-scaling-stroke" />`
      : nothing;
    const ghost = this.ghost;
    const drop = ghost
      ? svg`<g transform="translate(${number(ghost.props.x, 0)} ${number(ghost.props.y, 0)})" opacity=${DROP_PREVIEW_OPACITY} data-testid="drop-preview">${this.paintWidget(ghost, page, false, 0, 0)}</g>`
      : nothing;
    return svg`<g pointer-events="none" data-testid="selection">${drop}${handles}${rubber}</g>`;
  }

  /** WidgetItem.paint. */
  private paintWidget(
    widget: DesignWidget,
    page: DesignPage,
    previewActive: boolean,
    screenX: number,
    screenY: number,
  ): TemplateResult {
    const props = widget.props;
    const width = Math.max(MINIMUM_SIZE, number(props.width, 100));
    const height = Math.max(MINIMUM_SIZE, number(props.height, 40));
    if (previewActive) {
      // the frame shows the widget; outside the page an outline says where it is
      const inside =
        screenX >= 0 &&
        screenY >= 0 &&
        screenX + width <= page.display.width &&
        screenY + height <= page.display.height;
      return svg`${
        inside
          ? svg`<rect width=${width} height=${height} fill="transparent" />`
          : svg`<rect width=${width} height=${height} fill="transparent" stroke="#E08A00" stroke-width="1" stroke-dasharray="1 2" vector-effect="non-scaling-stroke" />`
      }${this.paintSelection(widget, width, height)}`;
    }
    const [themeBackground, themeForeground] = THEMES[widget.type] ?? ['#F5F5F5', '#222222'];
    const background = qtColor(props.bgColor, themeBackground);
    const foreground = qtColor(props.textColor, themeForeground);
    const border = Math.max(0, Math.trunc(number(props.borderWidth, 1)));
    const radius = Math.min(number(props.radius, 4), width / 2, height / 2);
    return svg`
      <rect x="0.5" y="0.5" width=${Math.max(0, width - 1)} height=${Math.max(0, height - 1)} rx=${radius} ry=${radius}
        fill=${background} stroke=${qtColor(props.borderColor, '#9E9E9E')} stroke-width=${border} />
      ${this.paintControl(widget, width, height, foreground)}
      ${this.paintSelection(widget, width, height)}
    `;
  }

  /** WidgetItem._paint_selection: a dashed outline. */
  private paintSelection(widget: DesignWidget, width: number, height: number): TemplateResult {
    if (!this.controller?.selected(this.pageId).includes(widget.name)) return svg``;
    return svg`<rect class="selected" width=${width} height=${height} fill="none" stroke=${SELECTION} stroke-width="1" stroke-dasharray="4 2" vector-effect="non-scaling-stroke" />`;
  }

  /** WidgetItem._paint_control: a sketch of what the widget is. */
  private paintControl(
    widget: DesignWidget,
    width: number,
    height: number,
    foreground: string,
  ): TemplateResult {
    const props = widget.props;
    const kind = widget.type;
    if (kind === 'slider' || kind === 'bar') {
      const low = number(props.min, 0);
      const high = number(props.max, 100);
      const ratio = (number(props.value, 50) - low) / Math.max(1, high - low);
      const groove = { x: 5, y: height / 2 - 3, width: width - 10, height: 6 };
      const knob = groove.x + groove.width * Math.max(0, Math.min(1, ratio));
      return svg`
        <rect x=${groove.x} y=${groove.y} width=${Math.max(0, groove.width)} height=${groove.height} rx="3" ry="3"
          fill=${qtColor(props.indicatorColor, foreground)} stroke=${foreground} stroke-width="2" />
        <circle cx=${knob} cy=${height / 2} r="6" fill="#FFFFFF" stroke=${foreground} stroke-width="2" />`;
    }
    if (kind === 'switch') {
      const checked = Boolean(props.checked);
      const fill = qtColor(checked ? props.onColor : props.offColor, foreground);
      const center = checked ? width - height / 2 : height / 2;
      return svg`
        <rect x="2" y="2" width=${Math.max(0, width - 4)} height=${Math.max(0, height - 4)} rx=${height / 2} ry=${height / 2}
          fill=${fill} stroke=${foreground} stroke-width="2" />
        <circle cx=${center} cy=${height / 2} r=${Math.max(0, height / 2 - 4)} fill="#FFFFFF" stroke=${foreground} stroke-width="2" />`;
    }
    if (kind === 'checkbox') {
      const checked = Boolean(props.checked);
      const box = { x: 2, y: height / 2 - 8 };
      return svg`
        <rect x=${box.x} y=${box.y} width="16" height="16"
          fill=${checked ? qtColor(props.checkedColor, '#2196F3') : '#FFFFFF'} stroke=${foreground} stroke-width="2" />
        ${
          checked
            ? svg`<polyline points="${box.x + 3},${box.y + 11} ${box.x + 7},${box.y + 11} ${box.x + 14},${box.y + 3}"
                fill="none" stroke=${foreground} stroke-width="2" />`
            : nothing
        }
        ${this.paintText(widget, 24, 0, width - 24, height, foreground)}`;
    }
    if (kind === 'arc') {
      // drawArc from 35° for 290°, counter-clockwise from three o'clock, as Qt counts angles
      const rx = Math.max(0, (width - 14) / 2);
      const ry = Math.max(0, (height - 14) / 2);
      const cx = width / 2;
      const cy = height / 2;
      const point = (degrees: number) => {
        const angle = (degrees * Math.PI) / 180;
        return `${cx + rx * Math.cos(angle)},${cy - ry * Math.sin(angle)}`;
      };
      return svg`<path d="M ${point(35)} A ${rx} ${ry} 0 1 0 ${point(325)}" fill="none" stroke=${foreground} stroke-width="2" />`;
    }
    if (kind === 'chart') {
      return svg`<polyline points="5,${height - 5} ${width / 2},${height / 2} ${width - 5},5" fill="none" stroke=${foreground} stroke-width="2" />`;
    }
    if (kind === 'table' || kind === 'keyboard' || kind === 'calendar') {
      const [rows, columns] = kind === 'keyboard' ? [4, 8] : [3, 3];
      const lines: TemplateResult[] = [];
      for (let row = 1; row < rows; row++) {
        const y = (height * row) / rows;
        lines.push(svg`<line x1="0" y1=${y} x2=${width} y2=${y} />`);
      }
      for (let column = 1; column < columns; column++) {
        const x = (width * column) / columns;
        lines.push(svg`<line x1=${x} y1="0" x2=${x} y2=${height} />`);
      }
      return svg`<g stroke=${foreground} stroke-width="2">${lines}</g>`;
    }
    return this.paintText(widget, 0, 0, width, height, foreground);
  }

  /** WidgetItem._paint_text: centred, wrapped, at the widget's font size. */
  private paintText(
    widget: DesignWidget,
    x: number,
    y: number,
    width: number,
    height: number,
    foreground: string,
  ): TemplateResult {
    const props = widget.props;
    const text = String(props.text || props.placeholder || widget.name);
    const size = Math.max(8, Math.trunc(number(props.fontSize, 14)));
    return svg`<foreignObject x=${x + 4} y=${y + 2} width=${Math.max(0, width - 8)} height=${Math.max(0, height - 4)}>
      <div xmlns="http://www.w3.org/1999/xhtml"
        style="display:flex;align-items:center;justify-content:center;text-align:center;width:100%;height:100%;overflow:hidden;overflow-wrap:anywhere;font:${size}px system-ui,sans-serif;color:${foreground}">${text}</div>
    </foreignObject>`;
  }
}

function lastLine(log: string): string {
  const lines = log.split('\n').filter((line) => line.trim());
  return lines.at(-1) ?? '';
}

customElements.define('lms-designer-view', DesignerView);

declare global {
  interface HTMLElementTagNameMap {
    'lms-designer-view': DesignerView;
  }
}
