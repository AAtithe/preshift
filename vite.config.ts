import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The API runs alongside in development (npm run server). With no server, the app falls back to the offline demo.
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
  test: { globals: true, environment: 'node' },
});
