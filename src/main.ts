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
  // In the capture phase: the terminal keeps the keys it handles from bubbling up.
  window.addEventListener(
    'keydown',
    (event) => {
      const panel = shell.renderRoot.querySelector('lms-sim-panel');
      const terminal = panel?.renderRoot.querySelector('.terminal');
      const path = event.composedPath();
      const inEditor = path.some(
        (node) => node instanceof HTMLElement && node.localName === 'lms-code-editor',
      );
      if (studio.shortcut(event, terminal ? path.includes(terminal) : false, inEditor)) {
        event.stopPropagation();
      }
    },
    true,
  );
  // no file watcher in the browser: the tabs look at their stores when the page is back
  window.addEventListener('focus', () => void studio.files.refreshFromStores());
  // the browser's own question when a page with unsaved changes is closed
  window.addEventListener('beforeunload', (event) => {
    if (studio.session.modified || studio.files.anyModified) event.preventDefault();
  });
}
