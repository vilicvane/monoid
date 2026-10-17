import {MaxUint256} from 'ethers';
import {type ComponentProps, type ReactNode, useEffect, useState} from 'react';

import type {EvmPermit} from '../../../@lib/evm-permit.js';
import type {EvmToken} from '../../../@lib/evm-token.js';
import {PopupDateTime} from '../../@ui/date-time.js';
import {EvmTokenAmount} from '../../@ui/evm-token.js';
import {FormattedNumber} from '../../@ui/formatted-number.js';
import {ErrorMessage} from '../../@ui/message-content.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

export function WalletConnectPermit({
  permit,
  token,
  signer,
  ...fieldProps
}: {
  permit: EvmPermit;
  token?: EvmToken;
  signer: string;
} & Omit<ComponentProps<typeof TypedDataFields>, 'renderValue'>): ReactNode {
  const [now, setNow] = useState(Date.now);
  const {owner, value, deadline} = permit;
  const expired = deadline < BigInt(Math.floor(now / 1000));
  const differentOwner = owner.toLowerCase() !== signer.toLowerCase();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <TypedDataFields
        {...fieldProps}
        renderValue={field => {
          if (field.name === 'value') {
            return {
              content:
                value === BigInt(0) ? (
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
                  />
                ) : (
                  <FormattedNumber
                    value={value.toString()}
                    fullValue={value.toString()}
                    unit={value === MaxUint256 ? undefined : 'base units'}
                    displayValue={
                      value === MaxUint256 ? 'Unlimited' : undefined
                    }
                    displayValueColor="var(--color-address-warning)"
                  />
                ),
            };
          }

          if (field.name === 'deadline') {
            return {
              content:
                deadline === MaxUint256 ? (
                  <FormattedNumber
                    value={deadline.toString()}
                    displayValue="No expiry"
                  />
                ) : deadline <= BigInt(8_640_000_000_000) ? (
                  <PopupDateTime
                    value={Number(deadline) * 1000}
                    showTimestamp
                  />
                ) : (
                  <FormattedNumber
                    value={deadline.toString()}
                    unit="Unix seconds"
                  />
                ),
            };
          }

          return undefined;
        }}
      />
      {differentOwner && (
        <ErrorMessage>Owner does not match signer.</ErrorMessage>
      )}
      {expired && <ErrorMessage>Permit signature has expired.</ErrorMessage>}
    </>
  );
}
