import {formatUnits} from 'ethers';
import type {ReactNode} from 'react';

import type {NativeCurrency} from '../../@lib/chain-names.js';

import {FormattedNumber} from './formatted-number.js';

export const NativeAmount = ({
  value,
  currency,
}: {
  value: bigint;
  currency?: NativeCurrency;
}): ReactNode => (
  <FormattedNumber
    value={currency ? formatUnits(value, currency.decimals) : value.toString()}
    unit={currency?.symbol ?? 'base units'}
    fullValue={value.toString()}
    decimals={currency?.decimals}
  />
);
