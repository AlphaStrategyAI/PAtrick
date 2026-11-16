import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/T00.test.mjs'],
    passWithNoTests: true,
  },
});
