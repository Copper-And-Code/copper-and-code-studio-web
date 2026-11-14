import { defineConfig } from 'vite';
import { upstreamInfo } from './scripts/upstream-info.mjs';

// GitHub Pages serves the site under the repository name. Dev and preview use the same base,
// so a wrong path shows up locally and not only once deployed.
export default defineConfig({
  base: '/lvgl-mpy-studio-web/',
  define: {
    __UPSTREAM__: JSON.stringify(upstreamInfo()),
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
