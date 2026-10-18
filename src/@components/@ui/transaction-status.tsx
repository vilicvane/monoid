import {
  ArrowRightLeft as arrowRightLeft,
  Check as check,
  X as x,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {EvmTransactionConfirmation} from '../../@lib/watch-evm-transaction.js';
import {popInAnimationCSS} from '../@animations.js';

import {AppIcon} from './app-icon.js';
import {LoadingSpinner} from './loading-spinner.js';

type Status = EvmTransactionConfirmation['status'];

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
        : $status === 'replaced'
          ? 'var(--color-text-secondary)'
          : 'var(--ion-color-primary)'};

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
                : x
          }
          aria-hidden="true"
        />
      )}
    </Icon>
  );
}
