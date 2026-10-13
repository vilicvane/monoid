import type {CapacitorConfig} from '@capacitor/cli';

export default {
  appId: 'app.monoid',
  appName: 'Monoid',
  webDir: 'dist',
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: false,
    },
    StatusBar: {
      style: 'LIGHT',
    },
  },
} satisfies CapacitorConfig;
