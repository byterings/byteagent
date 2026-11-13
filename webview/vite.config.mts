import react from '@vitejs/plugin-react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Production bundle loaded by the VS Code webview. File names are fixed so
// the extension can reference them without a manifest.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: join(here, '..', 'dist', 'webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    lib: {
      entry: join(here, 'src', 'main.tsx'),
      formats: ['es'],
      fileName: () => 'webview.js',
      cssFileName: 'webview',
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
