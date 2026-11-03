import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 15000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/web/**', 'src/index.ts', 'src/mcp.ts'] },
  },
});
