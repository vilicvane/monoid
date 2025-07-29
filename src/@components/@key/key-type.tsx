import type {ReactNode} from 'react';

import type {SafeKnownType} from '../../@atomics.js';

export const KeyType = ({type}: {type: SafeKnownType}): ReactNode => {
  switch (type) {
    case 'seed':
      return 'Seed';
    case 'master':
      return 'Master';
    case 'secp256k1':
      return 'SECP256K1';
    default:
      return type;
  }
};
