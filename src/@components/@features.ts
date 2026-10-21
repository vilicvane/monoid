import {Bitcoin as BitcoinIcon} from 'lucide-react';

import {
  FEATURES as FEATURE_DEFINITIONS,
  type FeatureRoute,
} from '../@features.js';

import type {AppIconSource} from './@ui/app-icon.js';
import {
  CardAppletsIcon,
  EthereumIcon,
  SolanaIcon,
  WalletConnectIcon,
} from './@ui/feature-icons.js';

const FEATURE_VISUALS: Record<
  FeatureRoute,
  {icon: AppIconSource; color: string}
> = {
  sessions: {icon: WalletConnectIcon, color: 'var(--ion-color-primary)'},
  bitcoin: {icon: BitcoinIcon, color: '#f7931a'},
  ethereum: {icon: EthereumIcon, color: '#627eea'},
  solana: {icon: SolanaIcon, color: '#9945ff'},
  cardApplets: {icon: CardAppletsIcon, color: 'var(--ion-color-safe)'},
};

export const FEATURES = FEATURE_DEFINITIONS.map(feature => ({
  ...feature,
  ...FEATURE_VISUALS[feature.route],
}));
