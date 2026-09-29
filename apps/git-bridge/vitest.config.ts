import { defineConfig } from 'vitest/config';

/**
 * The default suite is hermetic: pure logic, a scripted `execFile`, and no child processes.
 *
 * The SYS suite (`test/sys/**`) spawns the *built* companion and needs a real `git`, so it is
 * excluded here and run by `npm run test:sys`, which builds first.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'test/sys/**'],
  },
});
