import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.int.test.ts', 'e2e/**'],
    environment: 'node',
    environmentMatchGlobs: [
      ['lib/capture/**', 'happy-dom'],
      ['lib/dom/**', 'happy-dom'],
    ],
    restoreMocks: true,
  },
});
