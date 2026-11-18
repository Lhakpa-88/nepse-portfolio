import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' makes the build work at any GitHub Pages path (user.github.io/<repo>/).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
  build: { chunkSizeWarningLimit: 1500 },
  test: { environment: 'node' },
} as any);
