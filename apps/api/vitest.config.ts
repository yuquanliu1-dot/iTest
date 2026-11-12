import { configDefaults, defineConfig } from 'vitest/config';

// .data/repos is the repo-clone cache of the repo-context feature (containing the cloned projects' own tests);
// they are not part of this package's tests and must be excluded, otherwise vitest collects and runs them and fails.
// globalSetup starts the run-wide shared PG container (per-file isolated database, see test/globalSetup.ts);
// hookTimeout stays relaxed: settings.test.ts LLM probes, environments MySQL container startup, and other slow paths.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.data/**'],
    globalSetup: ['./test/globalSetup.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
