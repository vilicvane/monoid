import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode, useEffect, useState} from 'react';

import {useEntrances} from '../../../@entrances.js';
import type {EvmPermit2} from '../../../@lib/evm-permit2.js';
import {ErrorMessage} from '../../@ui/message-content.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

import {
  PermitAmount,
  PermitTime,
  PermitToken,
} from './wallet-connect-permit-value.js';

const MAX_AMOUNT = BigInt(2) ** BigInt(160) - BigInt(1);
const MAX_EXPIRATION = BigInt(2) ** BigInt(48) - BigInt(1);

export const WalletConnectPermit2 = observer(function WalletConnectPermit2({
  permit,
  ...fieldProps
}: {
  permit: EvmPermit2;
} & Omit<ComponentProps<typeof TypedDataFields>, 'renderValue'>): ReactNode {
  const {evmTokenService} = useEntrances();
  const [now, setNow] = useState(Date.now);
  const tokens = new Map(
    permit.details.map(detail => [
      detail.path,
      evmTokenService.getToken(permit.chainId, detail.token),
    ]),
  );
  const timestamp = BigInt(Math.floor(now / 1000));
  const signatureExpired = permit.sigDeadline < timestamp;
  const allowanceExpired = permit.details.some(
    detail => detail.expiration !== BigInt(0) && detail.expiration < timestamp,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void evmTokenService.refresh().catch(console.warn);
    for (const detail of permit.details) {
      void evmTokenService.resolve(permit.chainId, detail.token);
    }
  }, [evmTokenService, permit]);

  return (
    <>
      <TypedDataFields
        {...fieldProps}
        renderValue={(_field, path) => {
          if (path === '2') {
            return {content: <PermitTime value={permit.sigDeadline} />};
          }

          const detail = permit.details.find(detail =>
            path.startsWith(`${detail.path}.`),
          );
          if (!detail) return undefined;

          const token = tokens.get(detail.path);
          if (path === `${detail.path}.0` && token) {
            return {
              block: false,
              content: (
                <PermitToken
                  token={token}
                  kind={fieldProps.getAddressKind?.(detail.token) ?? 'unknown'}
                />
              ),
            };
          }

          if (path === `${detail.path}.1`) {
            return {
              content: (
                <PermitAmount
                  value={detail.amount}
                  token={token}
                  maximum={MAX_AMOUNT}
                />
              ),
            };
          }

          if (path === `${detail.path}.2`) {
            return {
              content: (
                <PermitTime
                  value={detail.expiration}
                  displayValue={
                    detail.expiration === BigInt(0)
                      ? 'Submission block'
                      : detail.expiration === MAX_EXPIRATION
                        ? 'Max expiry'
                        : undefined
                  }
                />
              ),
            };
          }

          return undefined;
        }}
      />
      {signatureExpired && (
        <ErrorMessage>Permit signature has expired.</ErrorMessage>
      )}
      {allowanceExpired && (
        <ErrorMessage>Token allowance has expired.</ErrorMessage>
      )}
    </>
  );
});
