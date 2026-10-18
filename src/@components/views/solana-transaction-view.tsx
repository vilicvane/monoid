import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getSignedSolanaTransactionSignature} from '../../@lib/send-solana-transaction.js';
import {canRefreshSolanaTransaction} from '../../@lib/watch-solana-transaction.js';
import type {Router} from '../../@routes.js';
import {useSolanaTransactionConfirmation} from '../@hooks/use-solana-transaction-confirmation.js';
import {AsyncButton} from '../@ui/button.js';
import {ErrorMessage} from '../@ui/message-content.js';

import {SolanaTransactionDetails} from './@sessions/solana-transaction-details.js';

export const SolanaTransactionView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['sessions']['solanaTransaction']
  >): ReactNode => {
    const {walletKitService} = useEntrances();
    const signature = useMemo(
      () => getSignedSolanaTransactionSignature(view.signedTransaction),
      [view.signedTransaction],
    );
    const active = !view.$leaving && view.$match.$exact.$active;
    const [attempt, setAttempt] = useState(0);
    const confirmation = useSolanaTransactionConfirmation(
      view.chainId,
      signature,
      active,
      attempt,
    );
    const refreshConfirmation = canRefreshSolanaTransaction(confirmation);
    const retryResponse =
      walletKitService.requests.has(view.id) &&
      !walletKitService.isRespondingToRequest(view.id);

    return (
      <SolanaTransactionDetails
        chainId={view.chainId}
        signature={signature}
        address={view.address}
        confirmation={confirmation}
        active={active}
        footer={
          (refreshConfirmation || retryResponse) && (
            <AsyncButton
              color="neutral"
              handler={async () => {
                if (refreshConfirmation) setAttempt(value => value + 1);
                if (retryResponse) {
                  await walletKitService.resumeSolanaTransactionRequest(
                    view.id,
                    view.topic,
                  );
                }
              }}
            >
              Refresh
            </AsyncButton>
          )
        }
      >
        {retryResponse && (
          <ErrorMessage>Could not notify the website.</ErrorMessage>
        )}
      </SolanaTransactionDetails>
    );
  },
);
