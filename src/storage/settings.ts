// The web's QSettings: values kept in localStorage, under the same keys as the desktop. Every
// read and write is guarded, because storage can be missing or refused (private windows,
// blocked site data); then the IDE works without remembering.

const PREFIX = 'lms.';

export interface SettingsBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultBackend(): SettingsBackend | null {
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
