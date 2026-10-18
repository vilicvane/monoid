import {History as history} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {formatBitcoinAmount} from '../../@lib/bitcoin-transaction.js';
import {getBitcoinWalletSigningAccount} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {useBitcoinWalletRefresh} from '../@hooks/use-bitcoin-wallet-refresh.js';
import {ReceiveAddressPopup} from '../@key/receive-address-popup.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AppIcon} from '../@ui/app-icon.js';
import {Button} from '../@ui/button.js';
import {PopupDateTime} from '../@ui/date-time.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {ErrorMessage, InfoMessage} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  ViewLoading,
  ViewPlaceholder,
} from '../@view/index.js';

const Balance = styled(InfoFieldsetValue)`
  padding: 8px 0;
  font-variant-numeric: tabular-nums;
`;

export const BitcoinWalletView = observer(
  ({view}: RouteComponentProps<Router['bitcoin']['wallet']>): ReactNode => {
    const {router, walletStorageService, bitcoinWalletService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const [receiving, setReceiving] = useState(false);
    const account = getBitcoinWalletSigningAccount(
      walletStorageService.keys,
      view.address,
    );
    const available = account !== undefined;
    const state = bitcoinWalletService.get(view.address);
    const {snapshot} = state;
    const route = router.bitcoin.wallet({address: view.address});
    useBitcoinWalletRefresh(view.address, active && available);

    useEffect(() => {
      setReceiving(false);
    }, [active, view.address]);

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Bitcoin</ViewHeaderTitle>
          {available && (
            <ViewHeaderButton
              aria-label="Transactions"
              onClick={() => route.transactions.$push()}
            >
              <AppIcon icon={history} />
            </ViewHeaderButton>
          )}
        </ViewHeader>
        <ViewContent
          footer={
            account && (
              <>
                <Button
                  disabled={
                    state.status !== 'ready' ||
                    !snapshot ||
                    snapshot.spendableBalance <= BigInt(0)
                  }
                  onClick={() => route.send.$push()}
                >
                  Send
                </Button>
                <Button color="neutral" onClick={() => setReceiving(true)}>
                  Receive
                </Button>
              </>
            )
          }
        >
          {!account ? (
            <ViewPlaceholder>
              This Bitcoin wallet is no longer in Safe.
            </ViewPlaceholder>
          ) : (
            <>
              <InfoSection>
                <WalletAccountList
                  keys={walletStorageService.keys}
                  addressType={account.wallet.addressType}
                  addresses={[view.address]}
                  compact
                  contained
                />
              </InfoSection>
              {state.error && (
                <ErrorMessage>
                  {state.error}
                  {snapshot && (
                    <span>
                      Showing cached balance from{' '}
                      <PopupDateTime value={snapshot.updatedAt} />.
                    </span>
                  )}
                </ErrorMessage>
              )}
              {snapshot ? (
                <InfoSection>
                  <InfoFieldset>
                    <InfoLegend>Balance</InfoLegend>
                    <Balance>
                      {formatBitcoinAmount(
                        snapshot.confirmedBalance + snapshot.pendingBalance,
                      )}{' '}
                      BTC
                    </Balance>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>Confirmed</InfoSectionItemLabel>
                      <span>
                        {formatBitcoinAmount(snapshot.confirmedBalance)} BTC
                      </span>
                    </InfoSectionRow>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>Pending</InfoSectionItemLabel>
                      <span>
                        {snapshot.pendingBalance > BigInt(0) ? '+' : ''}
                        {formatBitcoinAmount(snapshot.pendingBalance)} BTC
                      </span>
                    </InfoSectionRow>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>
                        Available to send
                      </InfoSectionItemLabel>
                      <span>
                        {formatBitcoinAmount(snapshot.spendableBalance)} BTC
                      </span>
                    </InfoSectionRow>
                  </InfoFieldset>
                  {snapshot.pendingBalance !== BigInt(0) && (
                    <InfoMessage>
                      Only confirmed funds are available to send.
                    </InfoMessage>
                  )}
                </InfoSection>
              ) : state.status !== 'error' ? (
                <ViewLoading />
              ) : null}
            </>
          )}
        </ViewContent>
        {account && receiving && active && (
          <ReceiveAddressPopup
            wallet={account.wallet}
            onDismiss={() => setReceiving(false)}
          />
        )}
      </View>
    );
  },
);
