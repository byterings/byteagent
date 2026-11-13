import react from '@vitejs/plugin-react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Builds the UI with a fake VS Code API so it can be opened in a normal
// browser for visual checks. Not shipped in the extension.
export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: {
    outDir: join(here, '..', 'dist', 'harness'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: { input: join(here, 'harness.html') },
  },
});
