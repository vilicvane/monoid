import {IonIcon} from '@ionic/react';
import list from 'lucide-static/icons/list.svg';
import {observer} from 'mobx-react-lite';
import {Fragment, type ReactNode, useEffect, useMemo, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {type AddressKind, getAddressKind} from '../../@lib/address-status.js';
import {
  getLatestEvmTokenApprovals,
  parseEvmTokenApprovals,
} from '../../@lib/evm-token-approvals.js';
import {
  getEvmTokenChanges,
  parseEvmTokenTransfers,
} from '../../@lib/evm-token-transfers.js';
import {type EvmToken, getEvmTokenAddressKind} from '../../@lib/evm-token.js';
import type {EvmTransactionReceipt} from '../../@lib/evm-transaction.js';
import {getKeyWallets} from '../../@services/index.js';

import {AddressDetailsContent} from './address-details.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupSection,
  DetailsPopupTitle,
} from './details-popup.js';
import {
  EvmTokenAmount,
  EvmTokenDetailsContent,
  EvmTokenLabel,
  EvmTokenTag,
} from './evm-token.js';
import {ExpandableAddress} from './expandable-address.js';
import {FormattedNumberDetailsContent} from './formatted-number.js';
import {IconButton} from './icon-button.js';
import {
  InfoSectionDivider,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoTable,
  InfoTableSection,
} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';
import {PopupAddress} from './popup-address.js';
import {BlackTag} from './tag.js';

const DetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

const Changes = styled(InfoTable)`
  width: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  overflow: visible;
  background: transparent;

  td {
    padding-inline: 0;
  }

  tr:first-child > * {
    padding-top: 4px;
  }

  tr:last-child > * {
    padding-bottom: 4px;
  }
`;

const Change = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  text-align: left;
`;

const TokenTag = styled(EvmTokenTag)`
  align-self: center;
  max-width: 60%;
`;

const TokenLabel = styled(EvmTokenLabel)`
  max-width: 60%;
`;

const Amount = styled.span<{$change?: bigint}>`
  flex-shrink: 0;
  max-width: 100%;
  margin-left: auto;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: ${({$change}) =>
    $change !== undefined && $change > BigInt(0)
      ? 'var(--ion-color-safe-shade)'
      : $change !== undefined && $change < BigInt(0)
        ? 'var(--color-text-danger)'
        : 'inherit'};
`;

const ChangeAmount = styled(Amount)`
  font-size: 18px;
`;

const Activity = styled(DetailsPopupSection)`
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 12px;
`;

const ActivityHeader = styled(InfoSectionHeader)`
  grid-column: 1 / -1;
  font-size: 14px;
`;

const ActivitySummary = styled(Change).attrs({as: 'button'})`
  grid-column: 1 / -1;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
`;

const ActivityAddress = styled(InfoSectionRow)`
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
  gap: inherit;

  > :last-child {
    min-width: 0;
    margin-left: 0;
    text-align: left;
  }
`;

export const EvmTokenActivity = observer(function EvmTokenActivity({
  chainId,
  signer,
  account = signer,
  receipt,
}: {
  chainId: string;
  signer: string;
  account?: string;
  receipt: EvmTransactionReceipt;
}): ReactNode {
  const {evmTokenService, addressBookService, walletStorageService} =
    useEntrances();
  const [detailsKind, setDetailsKind] = useState<'transfers' | 'approvals'>();
  const [selectedDetail, setSelectedDetail] = useState<
    | {type: 'address' | 'token'; address: string}
    | {type: 'amount'; value: bigint; address: string}
  >();
  const transfers = useMemo(() => parseEvmTokenTransfers(receipt), [receipt]);
  const approvals = useMemo(() => parseEvmTokenApprovals(receipt), [receipt]);
  const changes = useMemo(
    () => getEvmTokenChanges(transfers, account),
    [transfers, account],
  );
  const latestApprovals = useMemo(
    () => getLatestEvmTokenApprovals(approvals, account),
    [approvals, account],
  );
  const ownAddresses = new Set(
    walletStorageService.keys
      .flatMap(getKeyWallets)
      .filter(wallet => wallet.addressType === 'evm')
      .map(wallet => wallet.address.toLowerCase()),
  );
  const signedAddresses = new Set(
    [
      ...transfers.flatMap(transfer => [
        transfer.tokenAddress,
        transfer.from,
        transfer.to,
      ]),
      ...approvals.flatMap(approval => [
        approval.tokenAddress,
        approval.owner,
        approval.spender,
      ]),
    ]
      .filter(address => addressBookService.hasSigned('evm', address))
      .map(address => address.toLowerCase()),
  );

  useEffect(() => {
    for (const address of new Set(
      [...transfers, ...approvals].map(item => item.tokenAddress),
    )) {
      void evmTokenService.resolve(chainId, address);
    }
  }, [chainId, transfers, approvals, evmTokenService]);

  const tokenFor = (address: string): EvmToken =>
    evmTokenService.getToken(chainId, address) ?? {
      chainId: Number(chainId.split(':')[1]),
      address,
      name: address,
      symbol: 'ERC-20',
    };
  const tokenKind = (address: string): 'seen' | 'unknown' =>
    addressBookService.hasSigned('evm', address) ? 'seen' : 'unknown';
  const addressKind = (address: string): AddressKind =>
    getEvmTokenAddressKind(
      getAddressKind(address, signer, ownAddresses, signedAddresses),
      evmTokenService.isListed(chainId, address),
    );
  const tokenTag = (token: EvmToken, onClick?: () => void): ReactNode => (
    <TokenTag
      token={token}
      kind={tokenKind(token.address)}
      interactive={!!onClick}
      onClick={onClick}
    />
  );

  if (!transfers.length && !approvals.length) return null;

  return (
    <>
      {transfers.length > 0 && (
        <InfoTableSection>
          <InfoSectionHeader>
            <BlackTag>Token changes</BlackTag>
            <DetailsButton
              aria-label="All ERC-20 transfers"
              aria-haspopup="dialog"
              onClick={() => setDetailsKind('transfers')}
            >
              <IonIcon icon={list} aria-hidden="true" />
            </DetailsButton>
          </InfoSectionHeader>
          <Changes aria-label="Your ERC-20 net changes">
            <tbody>
              {changes.map(change => (
                <tr key={change.tokenAddress}>
                  <td>
                    <Change>
                      <TokenLabel
                        token={tokenFor(change.tokenAddress)}
                        kind={tokenKind(change.tokenAddress)}
                      />
                      <ChangeAmount $change={change.value}>
                        {change.value > BigInt(0) && '+'}
                        <EvmTokenAmount
                          token={tokenFor(change.tokenAddress)}
                          value={change.value}
                          showSymbol={false}
                        />
                      </ChangeAmount>
                    </Change>
                  </td>
                </tr>
              ))}
              {!changes.length && (
                <tr>
                  <td>
                    <Change>No change to this account</Change>
                  </td>
                </tr>
              )}
            </tbody>
          </Changes>
        </InfoTableSection>
      )}
      {approvals.length > 0 && (
        <InfoTableSection>
          <InfoSectionHeader>
            <BlackTag>Approvals</BlackTag>
            <DetailsButton
              aria-label="All ERC-20 approvals"
              aria-haspopup="dialog"
              onClick={() => setDetailsKind('approvals')}
            >
              <IonIcon icon={list} aria-hidden="true" />
            </DetailsButton>
          </InfoSectionHeader>
          <Changes aria-label="Your ERC-20 approvals">
            <tbody>
              {latestApprovals.map(approval => (
                <tr key={`${approval.tokenAddress}:${approval.spender}`}>
                  <td>
                    <Activity>
                      <ActivitySummary
                        type="button"
                        aria-haspopup="dialog"
                        onClick={() => setDetailsKind('approvals')}
                      >
                        <TokenLabel
                          token={tokenFor(approval.tokenAddress)}
                          kind={tokenKind(approval.tokenAddress)}
                          interactive={false}
                        />
                        <ChangeAmount>
                          <EvmTokenAmount
                            token={tokenFor(approval.tokenAddress)}
                            value={approval.value}
                            showSymbol={false}
                            maximumAsUnlimited
                            zeroAsRevoked
                            interactive={false}
                          />
                        </ChangeAmount>
                      </ActivitySummary>
                      <ActivityAddress>
                        <InfoSectionItemLabel>Spender</InfoSectionItemLabel>
                        <ExpandableAddress
                          kind={addressKind(approval.spender)}
                          mark={addressBookService.getMark(
                            'evm',
                            approval.spender,
                          )}
                          onClick={() => {
                            setDetailsKind('approvals');
                            setSelectedDetail({
                              type: 'address',
                              address: approval.spender,
                            });
                          }}
                        >
                          {approval.spender}
                        </ExpandableAddress>
                      </ActivityAddress>
                    </Activity>
                  </td>
                </tr>
              ))}
              {!latestApprovals.length && (
                <tr>
                  <td>
                    <ActivitySummary
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => setDetailsKind('approvals')}
                    >
                      No approvals from this account
                    </ActivitySummary>
                  </td>
                </tr>
              )}
            </tbody>
          </Changes>
        </InfoTableSection>
      )}
      {detailsKind && (
        <DetailsPopup
          aria-label={
            selectedDetail
              ? selectedDetail.type === 'token'
                ? 'Token details'
                : selectedDetail.type === 'amount'
                  ? 'Full value'
                  : 'Address details'
              : detailsKind === 'transfers'
                ? 'All ERC-20 transfers'
                : 'All ERC-20 approvals'
          }
          contentKey={
            selectedDetail
              ? selectedDetail.type === 'amount'
                ? `amount:${selectedDetail.value}`
                : `${selectedDetail.type}:${selectedDetail.address}`
              : detailsKind
          }
          initialFocus="dialog"
          onDismiss={() =>
            selectedDetail
              ? setSelectedDetail(undefined)
              : setDetailsKind(undefined)
          }
        >
          {selectedDetail?.type === 'amount' ? (
            <FormattedNumberDetailsContent
              title={
                <EvmTokenAmount
                  token={tokenFor(selectedDetail.address)}
                  value={selectedDetail.value}
                  maximumAsUnlimited={detailsKind === 'approvals'}
                  zeroAsRevoked={detailsKind === 'approvals'}
                  interactive={false}
                />
              }
              decimals={tokenFor(selectedDetail.address).decimals}
            >
              {selectedDetail.value.toString()}
            </FormattedNumberDetailsContent>
          ) : selectedDetail?.type === 'token' ? (
            <EvmTokenDetailsContent
              token={tokenFor(selectedDetail.address)}
              kind={tokenKind(selectedDetail.address)}
            />
          ) : selectedDetail ? (
            <AddressDetailsContent
              address={selectedDetail.address}
              kind={addressKind(selectedDetail.address)}
            />
          ) : (
            <>
              <DetailsPopupTitle>
                {detailsKind === 'transfers'
                  ? 'ERC-20 transfers'
                  : 'Approval events'}
              </DetailsPopupTitle>
              <DetailsPopupDivider />
              <DetailsPopupSection data-popup-animation-group>
                {(detailsKind === 'transfers' ? transfers : approvals).map(
                  (event, index) => {
                    const token = tokenFor(event.tokenAddress);
                    const approval = 'owner' in event;
                    const addresses = approval
                      ? [
                          ['Owner', event.owner],
                          ['Spender', event.spender],
                        ]
                      : [
                          ['From', event.from],
                          ['To', event.to],
                        ];
                    return (
                      <Fragment key={event.logIndex}>
                        {index > 0 && <InfoSectionDivider />}
                        <Activity>
                          <ActivityHeader>
                            {tokenTag(token, () =>
                              setSelectedDetail({
                                type: 'token',
                                address: token.address,
                              }),
                            )}
                            <Amount>
                              <EvmTokenAmount
                                token={token}
                                value={event.value}
                                showSymbol={!approval}
                                maximumAsUnlimited={approval}
                                zeroAsRevoked={approval}
                                onClick={() =>
                                  setSelectedDetail({
                                    type: 'amount',
                                    value: event.value,
                                    address: token.address,
                                  })
                                }
                              />
                            </Amount>
                          </ActivityHeader>
                          {addresses.map(([label, address]) => (
                            <ActivityAddress key={label}>
                              <InfoSectionItemLabel>
                                {label}
                              </InfoSectionItemLabel>
                              <PopupAddress
                                kind={addressKind(address)}
                                mark={addressBookService.getMark(
                                  'evm',
                                  address,
                                )}
                                onClick={() =>
                                  setSelectedDetail({type: 'address', address})
                                }
                              >
                                {address}
                              </PopupAddress>
                            </ActivityAddress>
                          ))}
                        </Activity>
                      </Fragment>
                    );
                  },
                )}
              </DetailsPopupSection>
            </>
          )}
        </DetailsPopup>
      )}
    </>
  );
});
