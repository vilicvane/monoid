import type {
  AppletInstallProgress,
  AppletReplacementProgress,
} from './install.js';

export const APPLET_NAMES = {
  identity: 'Monoid Identity Applet',
  library: 'Monoid Library',
  monoid: 'Monoid Applet',
  'security-key': 'Monoid Security Key Applet',
  otp: 'Monoid OTP Applet',
};

export const APPLET_SHORT_NAMES = {
  identity: 'Identity',
  library: undefined,
  monoid: 'Monoid',
  'security-key': 'Security Key',
  otp: 'OTP',
};

export function describeAppletInstallProgress(
  update: AppletInstallProgress | AppletReplacementProgress,
): {
  status: string;
  percentage?: number;
  count?: {completed: number; total: number};
} {
  if (update.stage === 'deleting') {
    return {
      status: `Removing ${APPLET_NAMES[update.applet]}...`,
      count: {completed: update.completed, total: update.total},
    };
  }
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
