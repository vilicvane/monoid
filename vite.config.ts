import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

import {viteHmrReconnect} from './scripts/vite-hmr-reconnect.mjs';

export default defineConfig({
  plugins: [react(), viteHmrReconnect()],
  esbuild: {
    target: 'es2024',
  },
  server: {
    proxy: {
      '/api/solana-idl': {
        target: 'https://idl.solana.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/solana-idl/, '/api/idl'),
      },
    },
  },
});
