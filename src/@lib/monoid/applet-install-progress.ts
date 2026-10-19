import type {AppletInstallProgress} from './install.js';

export const APPLET_NAMES = {
  identity: 'Monoid Identity Applet',
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
          ? 'Checking card, hold tight...'
          : 'Verifying installation, hold tight...',
    };
  }

  const name = APPLET_NAMES[update.stage];

  switch (update.phase) {
    case 'checking':
      return {status: `Checking ${name}, hold tight...`};
    case 'uploading':
      return {
        status: `Uploading ${name}...`,
        percentage: Math.floor(update.progress * 100),
      };
    case 'configuring':
      return {status: `Configuring ${name}, hold tight...`};
  }
}
