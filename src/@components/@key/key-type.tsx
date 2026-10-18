import type {ReactNode} from 'react';

import type {SafeKnownType} from '../../@atomics.js';

export const KeyType = ({type}: {type: SafeKnownType}): ReactNode => {
  return type.charAt(0).toUpperCase() + type.slice(1);
};
