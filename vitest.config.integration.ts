import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Integration tests against real dependencies started with Testcontainers.
// Needs Docker. Run: npm run test:integration
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    // Starting a container (and pulling its image on first run) is slow.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
