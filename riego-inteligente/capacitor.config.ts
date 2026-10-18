/// <reference types="@capacitor/background-runner" />
/// <reference types="@capacitor/local-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cl.riego.inteligente',
  appName: 'Riego Inteligente',
  webDir: 'www',
  plugins: {
    // Worker nativo (WorkManager) que ejecuta runner/background.ts (compilado a runners/background.js)
    BackgroundRunner: {
      label: 'cl.riego.inteligente.check',
      src: 'runners/background.js',
      event: 'refreshIrrigation',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
    LocalNotifications: {
      iconColor: '#2f80ed',
    },
  },
};

export default config;
