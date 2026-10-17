import {Transaction} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {AsyncButton} from '../@ui/button.js';
import {ErrorMessage} from '../@ui/message-content.js';

import {TransactionDetails} from './@sessions/transaction-details.js';

export const TransactionView = observer(
  ({
    view,
  }: RouteComponentProps<Router['sessions']['transaction']>): ReactNode => {
    const {walletKitService} = useEntrances();
    const transaction = useMemo(
      () => Transaction.from(view.signedTransaction),
      [view.signedTransaction],
    );
    const hash = transaction.hash!;
    const active = !view.$leaving && view.$match.$exact.$active;
    const [attempt, setAttempt] = useState(0);
    const data = {
      chainId: transaction.chainId,
      hash,
      from: transaction.from!,
      to: transaction.to,
      value: transaction.value,
    };
    const confirmation = useTransactionConfirmation(data, active, attempt);
    const {status} = confirmation;
    const responsePending = walletKitService.requests.has(view.id);
    const responding = walletKitService.isRespondingToRequest(view.id);
    const retryResponse = responsePending && !responding;
    const confirmationError =
      status === 'pending' && confirmation.error !== undefined;

    return (
      <TransactionDetails
        active={active}
        transaction={data}
        confirmation={confirmation}
        footer={
          (confirmationError || retryResponse) && (
            <AsyncButton
              color="neutral"
              handler={async () => {
                if (confirmationError) {
                  setAttempt(value => value + 1);
                }
                if (retryResponse) {
                  await walletKitService.approveTransactionRequest(
                    view.id,
                    view.topic,
                    transaction.unsignedSerialized,
                    transaction.signature!.serialized,
                  );
                }
              }}
            >
              Refresh
            </AsyncButton>
          )
        }
      >
        {confirmationError && (
          <ErrorMessage>Could not check confirmation.</ErrorMessage>
        )}
        {retryResponse && (
          <ErrorMessage>Could not notify the website.</ErrorMessage>
        )}
      </TransactionDetails>
    );
  },
);
