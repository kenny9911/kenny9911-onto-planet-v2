import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4100',
      '/mcp': 'http://localhost:4100',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
