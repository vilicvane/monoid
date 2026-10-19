import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {canRefreshSolanaTransaction} from '../../@lib/watch-solana-transaction.js';
import type {Router} from '../../@routes.js';
import type {SolanaTransactionHistoryItem} from '../../@services/index.js';
import {useSolanaTransactionConfirmation} from '../@hooks/use-solana-transaction-confirmation.js';
import {Button} from '../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {SolanaTransactionDetails} from './@sessions/solana-transaction-details.js';

export const SolanaTransactionHistoryView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['solana']['wallet']['transaction']
  >): ReactNode => {
    const {solanaTransactionHistoryService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const detail = solanaTransactionHistoryService.get(
      view.address,
      view.chainId,
      view.id,
    );

    return detail ? (
      <SolanaTransactionHistoryContent
        key={`${view.chainId}:${view.id}`}
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

const SolanaTransactionHistoryContent = observer(
  function SolanaTransactionHistoryContent({
    transaction,
    active,
  }: {
    transaction: SolanaTransactionHistoryItem;
    active: boolean;
  }): ReactNode {
    const [attempt, setAttempt] = useState(0);
    const confirmation = useSolanaTransactionConfirmation(
      transaction.chainId,
      transaction.signature,
      active,
      attempt,
    );

    return (
      <SolanaTransactionDetails
        chainId={transaction.chainId}
        signature={transaction.signature}
        address={transaction.address}
        confirmation={confirmation}
        active={active}
        footer={
          transaction.signature !== undefined &&
          canRefreshSolanaTransaction(confirmation) && (
            <Button
              color="neutral"
              onClick={() => setAttempt(value => value + 1)}
            >
              Refresh
            </Button>
          )
        }
      />
    );
  },
);
