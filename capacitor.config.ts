import type {CapacitorConfig} from '@capacitor/cli';

export default {
  appId: 'app.monoid',
  appName: 'Monoid',
  webDir: 'dist',
  loggingBehavior: 'none',
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: false,
    },
    StatusBar: {
      style: 'LIGHT',
    },
    SystemBars: {
      // Monoid handles safe areas and IME insets in its own layout.
      insetsHandling: 'disable',
      style: 'LIGHT',
    },
  },
} satisfies CapacitorConfig;
