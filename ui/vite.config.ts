import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server (ui/server/) runs separately (see package.json's dev:server) and
// is never bundled by Vite -- it needs real Node (fs, worker_threads, child
// processes) to run the harness, none of which belongs in browser code.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
