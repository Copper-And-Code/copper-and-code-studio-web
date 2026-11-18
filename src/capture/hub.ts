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
  | 'dialog-closed';

export interface CaptureEvent {
  type: CaptureEventType;
  /** Counts the events of this page, from 1. */
  seq: number;
  [detail: string]: unknown;
}

export class CaptureHub {
  private readonly frameListeners = new Set<(frame: CaptureFrame) => void>();
  private readonly eventListeners = new Set<(event: CaptureEvent) => void>();
  private seq = 0;
  /** The last frame of the simulator, or null before the first one of a run. */
  last: CaptureFrame | null = null;

  constructor(readonly enabled: boolean) {}

  onFrame(listener: (frame: CaptureFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
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
