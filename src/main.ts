import { Studio } from './app/studio.ts';
import { applyCaptureLook, installCapture } from './capture/api.ts';
import { captureOptions } from './capture/options.ts';
import { PythonBridge } from './py/bridge.ts';
import { language } from './i18n/tr.ts';
import { registerApp } from './pwa/pwa.ts';
import { Settings } from './storage/settings.ts';
import './ui/app-shell.ts';

document.documentElement.lang = language();
if (captureOptions.enabled) applyCaptureLook();

// The UI starts at once; Python loads in its worker meanwhile.
const python = new PythonBridge();
// the first call, so upstream's own messages are in the IDE's language from the start
python.call('set_language', language()).catch(() => {});
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
  // once Python has started, so the files cached for offline use do not slow the first load
  const pwa = () =>
    void registerApp({
      updateReady: (apply) => (shell.applyUpdate = apply),
      offlineReady: () => shell.offlineReady(),
    });
  // capture mode: no update offered in the middle of a recording
  if (!captureOptions.enabled) python.ready.then(pwa, pwa);
  window.lmsStudio.studio = studio;
  if (captureOptions.enabled) installCapture(studio, shell, python);
  window.lmsStudio.started = studio.start();
  // In the capture phase: the terminal keeps the keys it handles from bubbling up.
  window.addEventListener(
    'keydown',
    (event) => {
      // F10: to the menu bar, as in desktop applications (Shift+F10 is a context menu)
      if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        shell.renderRoot.querySelector('lms-menu-bar')?.focusMenuBar();
        return;
      }
      const panel = shell.renderRoot.querySelector('lms-sim-panel');
      const terminal = panel?.renderRoot.querySelector('.terminal');
      const path = event.composedPath();
      // an editor, or a field of a dialog: their keys are theirs, as in the desktop's text widgets
      const inEditor = path.some(
        (node) =>
          node instanceof HTMLElement &&
          ['lms-code-editor', 'input', 'textarea', 'select'].includes(node.localName),
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
