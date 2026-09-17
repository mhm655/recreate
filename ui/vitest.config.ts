import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one configures the client dev
// server (the /api proxy), which has nothing to do with running tests, and
// server/*.test.ts needs real Node (fs, http), not a browser-like environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
