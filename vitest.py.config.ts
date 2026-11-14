import { defineConfig } from 'vitest/config';

// Tests of upstream's Python running in Pyodide under Node.
export default defineConfig({
  test: {
    include: ['tests/py/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
