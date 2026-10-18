import {History as history} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
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
import {NativeAmount} from '../@ui/native-amount.js';
import {
  View,
  ViewActionButton,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  ViewLoading,
  ViewPlaceholder,
} from '../@view/index.js';

const BTC = {symbol: 'BTC', decimals: 8};

const Balance = styled(InfoFieldsetValue)`
  padding: 8px 0;
  font-variant-numeric: tabular-nums;
`;

const SendButton = styled(ViewActionButton)`
  --footer-action-exit-offset: -16px;
  transform-origin: center;
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
                <SendButton
                  visible={
                    active &&
                    !!snapshot &&
                    snapshot.spendableBalance > BigInt(0)
                  }
                  disabled={!active}
                  onClick={() => route.send.$push()}
                >
                  Send
                </SendButton>
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
                      <NativeAmount
                        value={
                          snapshot.confirmedBalance + snapshot.pendingBalance
                        }
                        currency={BTC}
                      />
                    </Balance>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>Confirmed</InfoSectionItemLabel>
                      <NativeAmount
                        value={snapshot.confirmedBalance}
                        currency={BTC}
                      />
                    </InfoSectionRow>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>Pending</InfoSectionItemLabel>
                      <span>
                        {snapshot.pendingBalance > BigInt(0) ? '+' : ''}
                        <NativeAmount
                          value={snapshot.pendingBalance}
                          currency={BTC}
                        />
                      </span>
                    </InfoSectionRow>
                    <InfoSectionRow>
                      <InfoSectionItemLabel>
                        Available to send
                      </InfoSectionItemLabel>
                      <NativeAmount
                        value={snapshot.spendableBalance}
                        currency={BTC}
                      />
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
