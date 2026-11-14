// The canvas of one page, as upstream's ui/designer/scene.py DesignerView and DesignerScene draw
// it: the page at its resolution with 40 pixels around it, the real LVGL frame when the preview
// has one of the right size, otherwise each widget painted as WidgetItem.paint does; the grid;
// the zoom, with Ctrl and the wheel too.
import { LitElement, css, html, nothing, svg, type TemplateResult } from 'lit';
import {
  type DesignPage,
  type DesignWidget,
  type DesignerController,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../app/designer.ts';
import { rgb565ToRgba } from '../app/preview.ts';
import { tr } from '../i18n/tr.ts';
import type { Menu, MenuItem } from './menu-bar.ts';
import './menu-bar.ts';

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

const number = (value: unknown, fallback: number): number => {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
};

export class DesignerView extends LitElement {
  static override properties = {
    controller: { attribute: false },
    pageId: { attribute: 'page-id' },
    revision: { type: Number },
    resolutions: { state: true },
  };

  controller: DesignerController | null = null;
  pageId = '';
  revision = 0;
  private resolutions: MenuItem[] = [];
  private drawn: unknown = null;

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

  private get page(): DesignPage | undefined {
    return this.controller?.pages.get(this.pageId);
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
          aria-label=${tr('Project resolution')}
          .menus=${this.resolutionMenu()}
        ></lms-menu-bar>
      </div>
      <div class="scroller" tabindex="0" aria-label=${page.name} @wheel=${this.wheel}>
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
            data-testid="canvas"
            viewBox="${-MARGIN} ${-MARGIN} ${sceneWidth} ${sceneHeight}"
            width=${sceneWidth * zoom}
            height=${sceneHeight * zoom}
            role="img"
            aria-label=${tr('Page {name}', { name: page.name })}
          >
            ${this.background(page, preview !== null)} ${this.items(page, preview !== null)}
          </svg>
        </div>
      </div>
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
      return svg`<g transform="translate(${x} ${y})" data-widget=${widget.name}>
        <title>${widget.name} (${widget.type})</title>
        ${this.paintWidget(widget, page, previewActive, left + x, top + y)}
        ${inner}
      </g>`;
    };
    return (children.get(null) ?? []).map((widget) => draw(widget, 0, 0));
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
      return inside
        ? svg`<rect width=${width} height=${height} fill="transparent" />`
        : svg`<rect width=${width} height=${height} fill="transparent" stroke="#E08A00" stroke-width="1" stroke-dasharray="1 2" vector-effect="non-scaling-stroke" />`;
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
    `;
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
