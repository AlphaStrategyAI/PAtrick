import { configDefaults, defineConfig } from 'vitest/config';

const installedNetwork = 'tests/unit/lima-installed-network.test.ts';

export default defineConfig({
  test: {
    testTimeout: 15000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/web/**', 'src/index.ts', 'src/mcp.ts'] },
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          exclude: [...configDefaults.exclude, installedNetwork],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'lima-network',
          include: [installedNetwork],
          // Real fsyncs share the disk with sibling suites. Give this fixture
          // its own group while retaining the existing per-test deadline.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
