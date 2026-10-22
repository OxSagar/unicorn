import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 10000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/unit.xml' },
  },
});
