import { defineConfig } from 'vitest/config';

/** System tests: a spawned companion, a real `git`, a real bare remote. Build first (`npm run test:sys`). */
export default defineConfig({
  test: {
    include: ['test/sys/**/*.sys.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
