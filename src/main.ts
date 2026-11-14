import { Studio } from './app/studio.ts';
import { PythonBridge } from './py/bridge.ts';
import { Settings } from './storage/settings.ts';
import './ui/app-shell.ts';

// The UI starts at once; Python loads in its worker meanwhile.
const python = new PythonBridge();
const settings = new Settings();
const shell = document.querySelector('lms-app');

declare global {
  interface Window {
    /** For tests and for looking inside from the browser's console. */
    lmsStudio: {
      python: PythonBridge;
      studio?: Studio;
      /** performance.now() when Python became ready: milliseconds since the page started loading. */
      pythonReadyAt?: number;
      /** Resolves when the project session has started. */
      started?: Promise<void>;
    };
  }
}

window.lmsStudio = { python };
python.ready.then(
  () => (window.lmsStudio.pythonReadyAt = performance.now()),
  () => {},
);

if (shell) {
  shell.python = python;
  await shell.updateComplete;
  const studio = new Studio(python, shell.dialogs, settings);
  shell.studio = studio;
  window.lmsStudio.studio = studio;
  window.lmsStudio.started = studio.start();
  window.addEventListener('keydown', (event) => studio.shortcut(event));
  // the browser's own question when a page with unsaved changes is closed
  window.addEventListener('beforeunload', (event) => {
    if (studio.session.modified) event.preventDefault();
  });
}
