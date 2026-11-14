import { PythonBridge } from './py/bridge.ts';
import './ui/app-shell.ts';

// The UI starts at once; Python loads in its worker meanwhile.
const python = new PythonBridge();
const app = document.querySelector('lms-app');
if (app) app.python = python;

declare global {
  interface Window {
    /** For tests and for looking inside from the browser's console. */
    lmsStudio: {
      python: PythonBridge;
      /** performance.now() when Python became ready: milliseconds since the page started loading. */
      pythonReadyAt?: number;
    };
  }
}
window.lmsStudio = { python };
python.ready.then(
  () => (window.lmsStudio.pythonReadyAt = performance.now()),
  () => {},
);
