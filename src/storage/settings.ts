// The web's QSettings: values kept in localStorage, under the same keys as the desktop. Every
// read and write is guarded, because storage can be missing or refused (private windows,
// blocked site data); then the IDE works without remembering.

import { captureOptions } from '../capture/options.ts';

const PREFIX = 'lms.';

export interface SettingsBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Capture mode: settings that live until the page closes, the user's own untouched. */
class MemoryBackend implements SettingsBackend {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

let memory: MemoryBackend | null = null;

function defaultBackend(): SettingsBackend | null {
  if (captureOptions.enabled) return (memory ??= new MemoryBackend());
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class Settings {
  constructor(private readonly backend: SettingsBackend | null = defaultBackend()) {}

  get<T>(key: string, fallback: T): T {
    try {
      const text = this.backend?.getItem(PREFIX + key);
      return text == null ? fallback : (JSON.parse(text) as T);
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    try {
      this.backend?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // not remembered: storage is full or refused
    }
  }

  remove(key: string): void {
    try {
      this.backend?.removeItem(PREFIX + key);
    } catch {
      // nothing to do
    }
  }
}
