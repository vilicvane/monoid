import globe from 'lucide-static/icons/globe.svg';
import history from 'lucide-static/icons/history.svg';

import {
  FEATURES as FEATURE_DEFINITIONS,
  type FeatureRoute,
} from '../@features.js';

const FEATURE_VISUALS: Record<FeatureRoute, {icon: string; color: string}> = {
  sessions: {icon: globe, color: 'var(--ion-color-primary)'},
  transactions: {icon: history, color: 'var(--ion-color-safe)'},
};

export const FEATURES = FEATURE_DEFINITIONS.map(feature => ({
  ...feature,
  ...FEATURE_VISUALS[feature.route],
}));
