import bitcoin from '@web3icons/core/svgs/networks/mono/bitcoin.svg.js';
import ethereum from '@web3icons/core/svgs/networks/mono/ethereum.svg.js';
import solana from '@web3icons/core/svgs/networks/mono/solana.svg.js';
import walletConnect from '@web3icons/core/svgs/wallets/mono/wallet-connect.svg.js';
import {CreditCard as creditCard} from 'lucide-react';

import {
  FEATURES as FEATURE_DEFINITIONS,
  type FeatureRoute,
} from '../@features.js';

import type {AppIconSource} from './@ui/app-icon.js';

const FEATURE_VISUALS: Record<
  FeatureRoute,
  {icon: AppIconSource; color: string}
> = {
  sessions: {icon: walletConnect, color: 'var(--ion-color-primary)'},
  bitcoin: {icon: bitcoin, color: '#f7931a'},
  ethereum: {icon: ethereum, color: '#627eea'},
  solana: {icon: solana, color: '#9945ff'},
  cardApplets: {icon: creditCard, color: 'var(--ion-color-safe)'},
};

export const FEATURES = FEATURE_DEFINITIONS.map(feature => ({
  ...feature,
  ...FEATURE_VISUALS[feature.route],
}));
