import { defineConfig } from 'vitest/config';

// Tests of upstream's Python running in Pyodide under Node. The board's calls use stack
// switching (JSPI), which Node 22 has behind a flag.
export default defineConfig({
  test: {
    // tests/hw/ runs only with LMS_BOARD_PORT set, on a real board
    include: ['tests/py/**/*.test.ts', 'tests/hw/**/*.test.ts'],
    testTimeout: 60_000,
    execArgv: ['--experimental-wasm-jspi'],
  },
});
