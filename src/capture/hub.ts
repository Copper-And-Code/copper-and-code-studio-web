// Where the IDE tells the capture contract what happens (docs/capture.md): the story's events and
// the simulator's frames. Without ?capture=1 nothing is kept and nothing is sent.
import { captureOptions } from './options.ts';

/** A frame of the simulator at the display's own resolution, as RGBA. */
export interface CaptureFrame {
  width: number;
  height: number;
  /** Counts the frames of this run, from 1. */
  number: number;
  pixels: Uint8ClampedArray;
}

export type CaptureEventType =
  | 'project-opened'
  | 'page-changed'
  | 'simulator-started'
  | 'simulator-stopped'
  | 'simulator-ended'
  | 'simulator-failed'
  | 'upload-started'
  | 'upload-progress'
  | 'upload-finished'
  | 'dialog-opened'
  | 'dialog-closed'
  | 'python-error'
  | 'output'
  | 'code-checked';

export interface CaptureEvent {
  type: CaptureEventType;
  /** Counts the events of this page, from 1. */
  seq: number;
  [detail: string]: unknown;
}

export class CaptureHub {
  private readonly frameListeners = new Set<(frame: CaptureFrame) => void>();
  private readonly boardListeners = new Set<(frame: CaptureFrame) => void>();
  private boardNumber = 0;
  /** The last frame of the demonstration board, or null. */
  lastBoard: CaptureFrame | null = null;
  private readonly eventListeners = new Set<(event: CaptureEvent) => void>();
  private seq = 0;
  /** The last frame of the simulator, or null before the first one of a run. */
  last: CaptureFrame | null = null;

  constructor(readonly enabled: boolean) {}

  onFrame(listener: (frame: CaptureFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onBoardFrame(listener: (frame: CaptureFrame) => void): () => void {
    this.boardListeners.add(listener);
    return () => this.boardListeners.delete(listener);
  }

  /** A frame of the demonstration board's display; number counts from 1 on each page load. */
  boardFrame(frame: CaptureFrame): void {
    if (!this.enabled) return;
    const numbered = { ...frame, number: ++this.boardNumber };
    this.lastBoard = numbered;
    for (const listener of this.boardListeners) {
      try {
        listener(numbered);
      } catch (error) {
        console.error(error);
      }
    }
  }

  onEvent(listener: (event: CaptureEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emit(type: CaptureEventType, detail: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const event: CaptureEvent = { ...detail, type, seq: ++this.seq };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(error);
      }
    }
  }

  frame(frame: CaptureFrame): void {
    if (!this.enabled) return;
    this.last = frame;
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

export const capture = new CaptureHub(captureOptions.enabled);
