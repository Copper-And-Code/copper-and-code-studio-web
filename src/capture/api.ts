// window.lmsCapture: the capture contract for programs that drive the IDE from outside, such as
// a video recorder with Playwright (docs/capture.md). Installed only with ?capture=1.
import type { Studio } from '../app/studio.ts';
import type { PythonBridge } from '../py/bridge.ts';
import type { AppShell } from '../ui/app-shell.ts';
import type { EditorCapture, TextPoint } from '../ui/code-editor.ts';
import { sceneRects } from '../ui/designer-view.ts';
import { type CaptureEvent, type CaptureFrame, capture } from './hub.ts';
import { type CaptureOptions, captureOptions } from './options.ts';

/** Raised when the contract changes in a way a caller must know: docs/capture.md, Versions. */
export const CAPTURE_VERSION = 1;

const IDLE_TIMEOUT_MS = 30_000;
/** Checks in a row with nothing to do, one frame apart, before idle() resolves. */
const QUIET_CHECKS = 3;

export interface LmsCapture {
  version: number;
  options: CaptureOptions;
  onFrame(listener: (frame: CaptureFrame) => void): () => void;
  onEvent(listener: (event: CaptureEvent) => void): () => void;
  /** The last frame of the simulator's run, or null. */
  frame(): CaptureFrame | null;
  /** The frames of the demonstration board's display (Device → Connect to Demo Board). */
  onBoardFrame(listener: (frame: CaptureFrame) => void): () => void;
  boardFrame(): CaptureFrame | null;
  /** clock=manual: moves the project's clock by ms; resolves with the frame after the step. */
  step(ms: number): Promise<CaptureFrame | null>;
  /** clock=manual: the pointer the project reads from the next step on, in display pixels. */
  pointer(x: number, y: number, pressed: boolean): void;
  /** Resolves when Python, the designer and the page have nothing left to do. */
  idle(timeoutMs?: number): Promise<void>;
  /**
   * As idle(), but without waiting for work only scheduled: the RAM budget's measure 1.5 s after
   * a change, the designer's drawing about to start. For the keys of a typed text.
   */
  settle(timeoutMs?: number): Promise<void>;
  /** The project as the IDE has it now; null before the first one. */
  project(): CaptureProject | null;
  /** A widget's box in the viewport, on the canvas of its page, if that page is shown. */
  widgetBox(name: string): CaptureBox | null;
  /** The editor the centre shows: the Code tab or a file tab; null otherwise. */
  editor(): (EditorCapture & { file: string }) | null;
  /** The viewport point of a line and column of that editor, if in view. */
  editorPoint(line: number, column: number): { x: number; y: number } | null;
  /** Pastes at the caret of that editor, as Ctrl+V: one undo step. */
  paste(text: string): void;
}

export interface CaptureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureWidget extends CaptureBox {
  name: string;
  type: string;
  /** The page's id. */
  page: string;
  /** The container's name, or null on the page itself. */
  parent: string | null;
  /** event → handler. */
  handlers: Record<string, string>;
}

export interface CaptureProject {
  name: string;
  board: string | null;
  resolution: [number, number];
  pages: { id: string; name: string; initial: boolean }[];
  /** The id of the page the designer shows, or null when another tab is in front. */
  page: string | null;
  widgets: CaptureWidget[];
  modules: string[];
  /** The widgets selected on the page shown. */
  selection: string[];
  dirty: boolean;
}

export type { TextPoint };

declare global {
  interface Window {
    lmsCapture?: LmsCapture;
  }
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

interface Shell extends HTMLElement {
  updateComplete: Promise<boolean>;
}

/** The look of the IDE for a capture: zoom and theme from the URL. */
export function applyCaptureLook(options: CaptureOptions = captureOptions): void {
  const root = document.documentElement;
  root.dataset.capture = '1';
  if (options.theme) root.dataset.theme = options.theme;
  if (options.zoom !== 1) root.style.setProperty('zoom', String(options.zoom));
}

export function installCapture(
  studio: Studio,
  shell: Shell & Pick<AppShell, 'shownEditor' | 'editors' | 'designerView'>,
  python: PythonBridge,
): LmsCapture {
  /** Nothing to do; scheduled: also nothing about to start (idle), or not (settle). */
  const quiet = async (scheduled: boolean): Promise<boolean> => {
    await shell.updateComplete;
    if (python.busy > 0) return false;
    const designer = studio.designer;
    if (designer && (scheduled ? !designer.idle : designer.drawing)) return false;
    if (!studio.code.idle || !studio.files.idle) return false;
    if (shell.editors().some((editor) => !editor.settled)) return false;
    const budget = studio.budget;
    if (budget && !budget.paused() && (scheduled ? !budget.idle : budget.measuring)) return false;
    return !document.getAnimations().some((animation) => animation.playState === 'running');
  };

  const wait = async (name: string, scheduled: boolean, timeoutMs: number) => {
    const until = performance.now() + timeoutMs;
    await window.lmsStudio.started;
    let calm = 0;
    while (calm < QUIET_CHECKS) {
      if (performance.now() > until) throw new Error(`${name}: still busy after ${timeoutMs} ms`);
      await nextFrame();
      calm = (await quiet(scheduled)) ? calm + 1 : 0;
    }
  };

  const api: LmsCapture = {
    ...authoring(studio, shell),
    version: CAPTURE_VERSION,
    options: captureOptions,
    onFrame: (listener) => capture.onFrame(listener),
    onEvent: (listener) => capture.onEvent(listener),
    frame: () => capture.last,
    onBoardFrame: (listener) => capture.onBoardFrame(listener),
    boardFrame: () => capture.lastBoard,
    async step(ms: number) {
      const run = studio.run;
      if (!run) throw new Error('step: the simulator is not there yet');
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`step: ${ms} is not a duration`);
      await run.step(ms);
      return capture.last;
    },
    pointer(x: number, y: number, pressed: boolean) {
      if (captureOptions.clock !== 'manual') throw new Error('pointer: only with the manual clock');
      studio.run?.pointer(x, y, pressed);
    },
    idle: (timeoutMs = IDLE_TIMEOUT_MS) => wait('idle', true, timeoutMs),
    settle: (timeoutMs = IDLE_TIMEOUT_MS) => wait('settle', false, timeoutMs),
  };
  window.lmsCapture = api;
  return api;
}

/** What a driver reads to aim and to check each step: the project, the canvas, the editor. */
function authoring(
  studio: Studio,
  shell: Pick<AppShell, 'shownEditor' | 'designerView'>,
): Pick<LmsCapture, 'project' | 'widgetBox' | 'editor' | 'editorPoint' | 'paste'> {
  return {
    project() {
      const state = studio.session.state;
      if (!state) return null;
      const designer = studio.designer;
      const widgets: CaptureWidget[] = [];
      for (const { id } of state.pages) {
        const page = designer?.pages.get(id);
        if (!page) continue;
        const rects = sceneRects(page);
        const names = new Map(page.widgets.map((widget) => [widget.id, widget.name]));
        for (const widget of page.widgets) {
          const rect = rects.get(widget.name);
          widgets.push({
            name: widget.name,
            type: widget.type,
            page: id,
            parent: widget.parentId ? (names.get(widget.parentId) ?? null) : null,
            x: rect?.x ?? 0,
            y: rect?.y ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            handlers: { ...(widget.events ?? {}) },
          });
        }
      }
      const shown = designer?.active ?? null;
      return {
        name: state.projectName,
        board: state.board,
        resolution: [state.display.width, state.display.height],
        pages: state.pages.map((page) => ({ id: page.id, name: page.name, initial: page.initial })),
        page: shown,
        widgets,
        modules: state.modules.map((module) => module.name),
        selection: shown && designer ? [...designer.selected(shown)] : [],
        dirty: state.modified,
      };
    },
    widgetBox(name: string) {
      const pageId = studio.designer?.pageOf(name);
      if (!pageId || studio.designer?.active !== pageId) return null;
      return shell.designerView(pageId)?.screenBox(name) ?? null;
    },
    editor() {
      const shown = shell.shownEditor();
      const state = shown?.editor.captureState();
      return shown && state ? { file: shown.file, ...state } : null;
    },
    editorPoint(line: number, column: number) {
      return shell.shownEditor()?.editor.pointAt(line, column) ?? null;
    },
    paste(text: string) {
      const shown = shell.shownEditor();
      if (!shown) throw new Error('paste: no editor is shown');
      if (!shown.editor.paste(String(text))) throw new Error('paste: the editor is read-only');
    },
  };
}
