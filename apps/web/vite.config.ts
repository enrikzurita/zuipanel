import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La web se sirve desde el panel en /admin/. En desarrollo, las llamadas a la
// API se redirigen al panel local (PANEL_URL, por defecto http://127.0.0.1:8080).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: {
      '/admin/api': process.env.PANEL_URL ?? 'http://127.0.0.1:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
