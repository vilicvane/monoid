import {MaxUint256} from 'ethers';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {EvmToken} from '../../../@lib/evm-token.js';
import {PopupDateTime} from '../../@ui/date-time.js';
import {EvmTokenAmount, EvmTokenTag} from '../../@ui/evm-token.js';
import {FormattedNumber} from '../../@ui/formatted-number.js';

export const PermitToken = styled(EvmTokenTag)`
  vertical-align: top;
`;

export function PermitAmount({
  value,
  token,
  maximum = MaxUint256,
}: {
  value: bigint;
  token?: EvmToken;
  maximum?: bigint;
}): ReactNode {
  return value === BigInt(0) ? (
    <FormattedNumber
      value="0"
      displayValue="Revoke"
      fullValue="0"
      unit={token?.symbol}
      decimals={token?.decimals}
    />
  ) : token ? (
    <EvmTokenAmount
      token={token}
      value={value}
      maximumAsUnlimited
      maximum={maximum}
    />
  ) : (
    <FormattedNumber
      value={value.toString()}
      fullValue={value.toString()}
      unit={value === maximum ? undefined : 'base units'}
      displayValue={value === maximum ? 'Unlimited' : undefined}
      displayValueColor="var(--color-address-warning)"
    />
  );
}

export function PermitTime({
  value,
  displayValue,
}: {
  value: bigint;
  displayValue?: string;
}): ReactNode {
  return displayValue !== undefined || value === MaxUint256 ? (
    <FormattedNumber
      value={value.toString()}
      displayValue={displayValue ?? 'No expiry'}
    />
  ) : value <= BigInt(8_640_000_000_000) ? (
    <PopupDateTime value={Number(value) * 1000} showTimestamp />
  ) : (
    <FormattedNumber value={value.toString()} unit="Unix seconds" />
  );
}
