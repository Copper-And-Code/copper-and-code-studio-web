import type { Location } from './store.ts';
import type { Settings } from './settings.ts';

const KEY = 'recentFiles';
const SIZE = 10; // ui/main_files.py: the new path and the 9 before it

export function recentFiles(settings: Settings): Location[] {
  const value = settings.get<unknown>(KEY, []);
  return Array.isArray(value)
    ? value.filter(
        (item): item is Location =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Location).store === 'string' &&
          typeof (item as Location).path === 'string',
      )
    : [];
}

export function addRecent(settings: Settings, location: Location): void {
  const others = recentFiles(settings).filter(
    (item) => item.store !== location.store || item.path !== location.path,
  );
  settings.set(KEY, [location, ...others].slice(0, SIZE));
}
