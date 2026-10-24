import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig({
  base: '/api/authority/',
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
});
