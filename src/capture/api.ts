// window.lmsCapture: the capture contract for programs that drive the IDE from outside, such as
// a video recorder with Playwright (docs/capture.md). Installed only with ?capture=1.
import type { Studio } from '../app/studio.ts';
import type { PythonBridge } from '../py/bridge.ts';
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
}

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

export function installCapture(studio: Studio, shell: Shell, python: PythonBridge): LmsCapture {
  const quiet = async (): Promise<boolean> => {
    await shell.updateComplete;
    if (python.busy > 0) return false;
    if (studio.designer && !studio.designer.idle) return false;
    const budget = studio.budget;
    if (budget && !budget.idle && !budget.paused()) return false;
    return !document.getAnimations().some((animation) => animation.playState === 'running');
  };

  const api: LmsCapture = {
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
    async idle(timeoutMs = IDLE_TIMEOUT_MS) {
      const until = performance.now() + timeoutMs;
      await window.lmsStudio.started;
      let calm = 0;
      while (calm < QUIET_CHECKS) {
        if (performance.now() > until) throw new Error(`idle: still busy after ${timeoutMs} ms`);
        await nextFrame();
        calm = (await quiet()) ? calm + 1 : 0;
      }
    },
  };
  window.lmsCapture = api;
  return api;
}
