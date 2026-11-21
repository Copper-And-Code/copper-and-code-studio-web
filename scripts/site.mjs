// Where the site is served: GitHub Pages serves it under the repository's name. Vite's `base`,
// the e2e tests and everything else take it from here; the code of the site reads
// import.meta.env.BASE_URL.
export const BASE = '/copper-and-code-studio-web/';

// The address up to the rename of 0.8.0: the same origin, so a user's settings and workspace
// written there are read under BASE (tests/e2e/rename.spec.ts).
export const OLD_BASE = '/lvgl-mpy-studio-web/';
