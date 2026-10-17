import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {EvmTransaction} from '../../@lib/evm-transaction.js';
import type {Router} from '../../@routes.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {Button} from '../@ui/button.js';
import {ErrorMessage} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {TransactionDetails} from './@sessions/transaction-details.js';

export const TransactionHistoryView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['transactions']['wallet']['transaction']
  >): ReactNode => {
    const {transactionHistoryService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const detail = transactionHistoryService.get(
      view.address,
      view.chainId,
      view.hash,
    );

    return detail ? (
      <TransactionHistoryContent
        key={`${view.chainId}:${view.hash}`}
        active={active}
        transaction={detail.transaction}
      />
    ) : (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transaction</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <ViewPlaceholder>Transaction not found.</ViewPlaceholder>
        </ViewContent>
      </View>
    );
  },
);

const TransactionHistoryContent = observer(function TransactionHistoryContent({
  transaction,
  active,
}: {
  transaction: EvmTransaction;
  active: boolean;
}): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const confirmation = useTransactionConfirmation(transaction, active, attempt);
  const error =
    confirmation.status === 'pending' && confirmation.error !== undefined;

  return (
    <TransactionDetails
      active={active}
      transaction={transaction}
      confirmation={confirmation}
      footer={
        error && (
          <Button
            color="neutral"
            onClick={() => setAttempt(value => value + 1)}
          >
            Refresh
          </Button>
        )
      }
    >
      {error && <ErrorMessage>Could not check confirmation.</ErrorMessage>}
    </TransactionDetails>
  );
});
