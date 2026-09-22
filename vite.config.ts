import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR can be disabled via the DISABLE_HMR env var.
      // Disabling it prevents page flicker while files are being edited in bulk.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU.
      // The `ignored` globs keep server-side + test + data files out of the client
      // watcher: tsx doesn't hot-reload server code anyway, and a vitest run rewriting
      // *.test.ts must never trigger a browser page-reload.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/server/**', '**/*.test.ts', '**/generations/**', '**/projects/**', '**/backups/**'],
      },
    },
  };
});
