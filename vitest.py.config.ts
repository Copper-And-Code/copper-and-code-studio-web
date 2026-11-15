import { defineConfig } from 'vitest/config';

// Tests of upstream's Python running in Pyodide under Node. The board's calls use stack
// switching (JSPI), which Node 22 has behind a flag.
export default defineConfig({
  test: {
    include: ['tests/py/**/*.test.ts'],
    testTimeout: 60_000,
    execArgv: ['--experimental-wasm-jspi'],
  },
});
