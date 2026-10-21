import {List as list} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {Fragment, type ReactNode, useEffect, useMemo, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {AddressKind} from '../../@lib/address-status.js';
import {formatTokenAmount} from '../../@lib/format-decimal.js';
import {SOLANA_TOKEN_PROGRAM} from '../../@lib/solana-token-instruction.js';
import {
  type SolanaTransactionBalances,
  getSolanaTokenBalanceChanges,
} from '../../@lib/solana-transaction-balances.js';
import {getKeyWallets} from '../../@services/index.js';
import {KeyDerivationTag} from '../@key/key-tags.js';

import {getAddressMarkerLabel} from './address-marker.js';
import {AppIcon} from './app-icon.js';
import {ChainIcon} from './chain-icon.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupHeader,
  DetailsPopupSection,
  DetailsPopupTitle,
} from './details-popup.js';
import {
  FormattedNumber,
  FormattedNumberDetailsContent,
} from './formatted-number.js';
import {
  InfoSectionDivider,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionLoadingSpinner,
  InfoSectionRow,
  InfoTableSection,
} from './info-section.js';
import {InfoMessage} from './message-content.js';
import {CenteredPopupAddress, PopupAddress} from './popup-address.js';
import {
  type SolanaToken,
  SolanaTokenAmount,
  SolanaTokenDetailsContent,
  SolanaTokenTag,
} from './solana-token.js';
import {BlackTag} from './tag.js';
import {
  TokenActivity,
  TokenActivityAddress,
  TokenActivityAmount,
  TokenActivityDetailsButton,
  TokenActivityHeader,
  TokenChange,
  TokenChangeAmount,
  TokenChangesTable,
} from './token-activity.js';
import {TokenLabel, TokenLabelName} from './token-label.js';

const Token = styled(SolanaTokenTag)`
  align-self: center;
  max-width: 60%;
`;

const NativeToken = styled(TokenLabel)`
  max-width: 60%;
`;

const NativeIcon = styled(ChainIcon)`
  width: 24px;
  height: 24px;
`;

type BalanceChange = {
  address: string;
  label: 'Account' | 'Owner' | 'Token account';
  value: bigint;
  token?: SolanaToken;
};

type Detail =
  | {type: 'balances'}
  | {type: 'token'; token: SolanaToken}
  | {type: 'amount'; change: BalanceChange}
  | {type: 'address'; address: string; label: BalanceChange['label']};

export const SolanaTokenActivity = observer(function SolanaTokenActivity({
  chainId,
  signer,
  balances,
}: {
  chainId: string;
  signer: string;
  balances?: SolanaTransactionBalances;
}): ReactNode {
  const {
    chainService,
    solanaTokenService,
    walletStorageService,
    addressBookService,
  } = useEntrances();
  const [details, setDetails] = useState<Detail[]>([]);
  const selected = details.at(-1);
  const currency = chainService.getNativeCurrency(chainId) ?? {
    symbol: 'SOL',
    decimals: 9,
  };
  const changes = useMemo<BalanceChange[]>(() => {
    if (!balances) return [];

    const tokenAccounts = new Set(balances.tokens?.map(token => token.address));

    return [
      ...(balances.native ?? []).flatMap<BalanceChange>(
        ({address, before, after}) =>
          before === after
            ? []
            : [
                {
                  address,
                  value: after - before,
                  label: tokenAccounts.has(address)
                    ? 'Token account'
                    : 'Account',
                },
              ],
      ),
      ...getSolanaTokenBalanceChanges(balances).map(change => ({
        address: (change.owner ?? change.account)!,
        label: change.owner ? ('Owner' as const) : ('Token account' as const),
        value: change.value,
        token: {
          mint: change.mint,
          decimals: change.decimals,
          programId: change.programId,
        },
      })),
    ];
  }, [balances]);
  const accountChanges = changes.filter(
    change =>
      change.address === signer && (!change.token || change.label === 'Owner'),
  );
  const unknownOwners = balances?.tokens?.some(
    token =>
      (token.before !== undefined && token.before.owner === undefined) ||
      (token.after !== undefined && token.after.owner === undefined),
  );
  const unavailable =
    balances?.native === undefined && balances?.tokens === undefined;
  const incomplete =
    balances?.native === undefined ||
    balances.tokens === undefined ||
    !balances.native.some(balance => balance.address === signer) ||
    unknownOwners;
  const ownAddresses = new Set(
    walletStorageService.keys
      .flatMap(getKeyWallets)
      .filter(wallet => wallet.addressType === 'solana')
      .map(wallet => wallet.address),
  );
  const addressKind = (
    address: string,
    label: BalanceChange['label'],
  ): AddressKind | undefined =>
    label === 'Token account'
      ? undefined
      : address === signer
        ? 'signer'
        : ownAddresses.has(address)
          ? 'own'
          : addressBookService.hasSigned('solana', address)
            ? 'seen'
            : 'unknown';
  const selectedAddressKind =
    selected?.type === 'address'
      ? addressKind(selected.address, selected.label)
      : undefined;
  const shouldHighlightAddress = (
    address: string,
    label: BalanceChange['label'],
  ): boolean =>
    label === 'Owner' ||
    (label === 'Account' && (address === signer || ownAddresses.has(address)));
  const openDetail = (detail: Detail): void =>
    setDetails(previous => [...previous, detail]);

  useEffect(() => {
    void solanaTokenService.resolve(
      chainId,
      (balances?.tokens ?? []).flatMap(token =>
        !token.programId || token.programId === SOLANA_TOKEN_PROGRAM
          ? [token.mint]
          : [],
      ),
    );
  }, [chainId, balances, solanaTokenService]);

  const tokenLabel = (
    change: BalanceChange,
    appearance: 'tag' | 'label',
  ): ReactNode =>
    change.token ? (
      <Token
        chainId={chainId}
        token={change.token}
        appearance={appearance}
        onClick={() => openDetail({type: 'token', token: change.token!})}
      />
    ) : (
      <NativeToken>
        <NativeIcon chainId={chainId} />
        <TokenLabelName>{currency.symbol}</TokenLabelName>
      </NativeToken>
    );
  const amount = (change: BalanceChange, onClick: () => void): ReactNode =>
    change.token ? (
      <SolanaTokenAmount
        chainId={chainId}
        token={change.token}
        value={change.value}
        showSymbol={false}
        onClick={onClick}
      />
    ) : (
      <FormattedNumber
        value={formatTokenAmount(change.value, currency.decimals)}
        fullValue={change.value.toString()}
        decimals={currency.decimals}
        onClick={onClick}
      />
    );
  const fullAmount = (change: BalanceChange): string => {
    const token = change.token;
    const metadata = token
      ? solanaTokenService.getToken(chainId, token.mint)
      : undefined;
    const decimals = token ? token.decimals : currency.decimals;
    const symbol = token
      ? metadata &&
        metadata.decimals === decimals &&
        (!token.programId || token.programId === SOLANA_TOKEN_PROGRAM)
        ? metadata.symbol
        : 'tokens'
      : currency.symbol;

    return `${decimals === undefined ? change.value.toString() : formatTokenAmount(change.value, decimals)} ${symbol}`;
  };
  const detailKey = selected
    ? selected.type === 'balances'
      ? 'balances'
      : selected.type === 'token'
        ? `token:${selected.token.mint}`
        : selected.type === 'address'
          ? `address:${selected.address}`
          : `amount:${selected.change.token?.mint ?? 'native'}:${selected.change.value}`
    : undefined;

  return (
    <>
      <InfoTableSection>
        <InfoSectionHeader>
          <BlackTag>Token changes</BlackTag>
          {balances === undefined ? (
            <InfoSectionLoadingSpinner aria-label="Loading balance changes" />
          ) : changes.length > 0 ? (
            <TokenActivityDetailsButton
              aria-label="All balance changes"
              aria-haspopup="dialog"
              onClick={() => openDetail({type: 'balances'})}
            >
              <AppIcon icon={list} aria-hidden="true" />
            </TokenActivityDetailsButton>
          ) : null}
        </InfoSectionHeader>
        {balances !== undefined && (
          <>
            {!!accountChanges.length && (
              <TokenChangesTable aria-label="Your net balance changes">
                <tbody>
                  {accountChanges.map(change => (
                    <tr
                      key={`${change.token?.mint ?? 'native'}:${change.token?.programId ?? ''}`}
                    >
                      <td>
                        <TokenChange>
                          {tokenLabel(change, 'label')}
                          <TokenChangeAmount $change={change.value}>
                            {change.value > BigInt(0) && '+'}
                            {amount(change, () =>
                              openDetail({type: 'amount', change}),
                            )}
                          </TokenChangeAmount>
                        </TokenChange>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TokenChangesTable>
            )}
            {incomplete ? (
              <InfoMessage>
                {unavailable
                  ? 'Balance changes unavailable.'
                  : 'Balance data is incomplete.'}
              </InfoMessage>
            ) : !accountChanges.length ? (
              <InfoMessage>No change to this account.</InfoMessage>
            ) : null}
          </>
        )}
      </InfoTableSection>
      {selected && (
        <DetailsPopup
          aria-label={
            selected.type === 'balances'
              ? 'All balance changes'
              : selected.type === 'token'
                ? 'Token details'
                : selected.type === 'amount'
                  ? 'Full value'
                  : 'Address details'
          }
          contentKey={detailKey}
          initialFocus="dialog"
          onDismiss={() => setDetails(previous => previous.slice(0, -1))}
        >
          {selected.type === 'token' ? (
            <SolanaTokenDetailsContent
              chainId={chainId}
              token={selected.token}
            />
          ) : selected.type === 'amount' ? (
            <FormattedNumberDetailsContent
              title={fullAmount(selected.change)}
              decimals={
                selected.change.token
                  ? selected.change.token.decimals
                  : currency.decimals
              }
            >
              {selected.change.value.toString()}
            </FormattedNumberDetailsContent>
          ) : selected.type === 'address' ? (
            <>
              <DetailsPopupHeader>
                <KeyDerivationTag chain="solana">Solana</KeyDerivationTag>
              </DetailsPopupHeader>
              <CenteredPopupAddress
                highlightEdges={shouldHighlightAddress(
                  selected.address,
                  selected.label,
                )}
              >
                {selected.address}
              </CenteredPopupAddress>
              <DetailsPopupDivider />
              <InfoSectionRow>
                <InfoSectionItemLabel>Account type</InfoSectionItemLabel>
                <span>{selected.label}</span>
              </InfoSectionRow>
              {selectedAddressKind && (
                <InfoSectionRow>
                  <InfoSectionItemLabel>Identity</InfoSectionItemLabel>
                  <span>{getAddressMarkerLabel(selectedAddressKind)}</span>
                </InfoSectionRow>
              )}
            </>
          ) : (
            <>
              <DetailsPopupTitle>Balance changes</DetailsPopupTitle>
              <DetailsPopupDivider />
              {incomplete && (
                <InfoMessage>
                  {unavailable
                    ? 'Balance changes unavailable.'
                    : 'Balance data is incomplete.'}
                </InfoMessage>
              )}
              <DetailsPopupSection data-popup-animation-group>
                {changes.map((change, index) => (
                  <Fragment
                    key={`${change.label}:${change.address}:${change.token?.mint ?? 'native'}:${change.token?.programId ?? ''}`}
                  >
                    {index > 0 && <InfoSectionDivider />}
                    <TokenActivity>
                      <TokenActivityHeader>
                        {tokenLabel(change, 'tag')}
                        <TokenActivityAmount $change={change.value}>
                          {change.value > BigInt(0) && '+'}
                          {amount(change, () =>
                            openDetail({type: 'amount', change}),
                          )}
                        </TokenActivityAmount>
                      </TokenActivityHeader>
                      <TokenActivityAddress>
                        <InfoSectionItemLabel>
                          {change.label}
                        </InfoSectionItemLabel>
                        <PopupAddress
                          highlightEdges={shouldHighlightAddress(
                            change.address,
                            change.label,
                          )}
                          kind={addressKind(change.address, change.label)}
                          mark={
                            change.label === 'Token account'
                              ? undefined
                              : addressBookService.getMark(
                                  'solana',
                                  change.address,
                                )
                          }
                          onClick={() =>
                            openDetail({
                              type: 'address',
                              address: change.address,
                              label: change.label,
                            })
                          }
                        >
                          {change.address}
                        </PopupAddress>
                      </TokenActivityAddress>
                    </TokenActivity>
                  </Fragment>
                ))}
                {!changes.length && !incomplete && (
                  <InfoMessage>No balance changes.</InfoMessage>
                )}
              </DetailsPopupSection>
            </>
          )}
        </DetailsPopup>
      )}
    </>
  );
});
