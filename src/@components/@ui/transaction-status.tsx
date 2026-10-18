import {
  ArrowRightLeft as arrowRightLeft,
  Check as check,
  Signature as signature,
  Unlink as unlink,
  X as x,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {EvmTransactionConfirmation} from '../../@lib/watch-evm-transaction.js';
import type {SolanaTransactionConfirmation} from '../../@lib/watch-solana-transaction.js';
import {popInAnimationCSS} from '../@animations.js';

import {AppIcon} from './app-icon.js';
import {LoadingSpinner} from './loading-spinner.js';

type Status =
  | EvmTransactionConfirmation['status']
  | SolanaTransactionConfirmation['status'];

const Icon = styled.span<{$status: Status}>`
  ${popInAnimationCSS}
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1em;
  height: 1em;
  font-size: 24px;
  color: ${({$status}) =>
    $status === 'confirmed'
      ? 'var(--ion-color-safe)'
      : $status === 'failed'
        ? 'var(--ion-color-danger)'
        : $status === 'replaced' || $status === 'signed'
          ? 'var(--color-text-secondary)'
          : $status === 'not-found'
            ? 'var(--color-text-caution)'
            : 'var(--ion-color-primary)'};

  > ${AppIcon} {
    font-size: ${({$status}) => ($status === 'not-found' ? '0.875em' : '1em')};
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export function TransactionStatus({
  status,
  className,
}: {
  status: Status;
  className?: string;
}): ReactNode {
  return (
    <Icon
      key={status}
      className={className}
      $status={status}
      role="status"
      aria-live="polite"
      aria-label={
        status === 'pending'
          ? 'Pending confirmation'
          : status === 'confirmed'
            ? 'Confirmed'
            : status === 'replaced'
              ? 'Replaced'
              : status === 'signed'
                ? 'Signed'
                : status === 'not-found'
                  ? 'Not found'
                  : 'Failed'
      }
    >
      {status === 'pending' ? (
        <LoadingSpinner />
      ) : (
        <AppIcon
          icon={
            status === 'confirmed'
              ? check
              : status === 'replaced'
                ? arrowRightLeft
                : status === 'signed'
                  ? signature
                  : status === 'not-found'
                    ? unlink
                    : x
          }
          aria-hidden="true"
        />
      )}
    </Icon>
  );
}

export const TransactionHeaderStatus = styled(TransactionStatus)`
  grid-column: 3;
  align-self: center;
  justify-self: end;
`;
