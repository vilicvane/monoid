import {type ComponentProps, type ReactNode, useEffect, useState} from 'react';

import type {EvmPermit} from '../../../@lib/evm-permit.js';
import type {EvmToken} from '../../../@lib/evm-token.js';
import {ErrorMessage} from '../../@ui/message-content.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

import {PermitAmount, PermitTime} from './wallet-connect-permit-value.js';

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
              content: <PermitAmount value={value} token={token} />,
            };
          }

          if (field.name === 'deadline') {
            return {
              content: <PermitTime value={deadline} />,
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
