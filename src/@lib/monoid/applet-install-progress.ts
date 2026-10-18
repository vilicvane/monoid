import type {AppletInstallProgress} from './install.js';

export const APPLET_NAMES = {
  identity: 'Monoid Safe Identity Applet',
  safe: 'Monoid Safe Applet',
  monoid: 'Monoid Applet',
};

export function describeAppletInstallProgress(update: AppletInstallProgress): {
  status: string;
  percentage?: number;
} {
  if (!('phase' in update)) {
    return {
      status:
        update.stage === 'checking'
          ? 'Checking card...'
          : 'Verifying installation, hold tight...',
    };
  }

  const name = APPLET_NAMES[update.stage];

  switch (update.phase) {
    case 'checking':
      return {status: `Checking ${name}...`};
    case 'uploading':
      return {
        status: `Uploading ${name}...`,
        percentage: Math.floor(update.progress * 100),
      };
    case 'configuring':
      return {status: `Configuring ${name}...`};
  }
}
