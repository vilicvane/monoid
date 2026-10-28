import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(({mode}) => ({
  base: mode === 'development' ? '/api/authority/' : '/',
  build: {
    rollupOptions: {
      input: ['index.html', 'home.html', 'privacy.html', 'terms.html'].map(
        path => fileURLToPath(new URL(path, import.meta.url)),
      ),
    },
  },
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      'styled-components',
      '@ionic/react',
      'mobx',
      'mobx-react-lite',
    ],
    alias: {
      classNames: 'classnames',
    },
  },
  server: {
    fs: {allow: [fileURLToPath(new URL('../../../', import.meta.url))]},
    proxy: {
      '/api/authority/auth/': 'http://localhost:8787',
    },
  },
}));
