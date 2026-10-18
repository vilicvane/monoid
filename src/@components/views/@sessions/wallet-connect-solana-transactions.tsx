import {hexlify} from 'ethers';
import {List as list} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import {UI_LOCALE} from '../../../@lib/locale.js';
import type {SolanaTransactionSimulation} from '../../../@lib/simulate-solana-transaction.js';
import {isSolanaTokenInstruction} from '../../../@lib/solana-token-instruction.js';
import type {
  SolanaInstructionReview,
  SolanaTransactionReview,
} from '../../../@lib/solana-transaction-review.js';
import type {WalletConnectSolanaTransactionRequest} from '../../../@lib/wallet-connect-request.js';
import type {WalletKeyData} from '../../../@services/index.js';
import {WalletAccountFieldset} from '../../@key/wallet-account-fieldset.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {WalletAddressFieldset} from '../../@key/wallet-address-fieldset.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {CopyButton} from '../../@ui/copy-button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {ExpandableAddress} from '../../@ui/expandable-address.js';
import {FormattedNumber} from '../../@ui/formatted-number.js';
import {IconButton} from '../../@ui/icon-button.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoPanel,
  InfoSection,
  InfoSectionHeader,
  InfoSectionItem,
  InfoSectionItemLabel,
  InfoSectionLoadingSpinner,
  InfoSectionRow,
} from '../../@ui/info-section.js';
import {inlineIconCSS} from '../../@ui/inline-icon.js';
import {
  InfoMessage,
  MessageContent,
  MessageSectionHeader,
  MessageSectionTitle,
  WarningMessage,
} from '../../@ui/message-content.js';
import {NativeAmount} from '../../@ui/native-amount.js';
import {SolanaTokenTag} from '../../@ui/solana-token.js';
import {SolanaTransactionSimulationSection} from '../../@ui/solana-transaction-simulation.js';
import {WhiteTag} from '../../@ui/tag.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

import {WalletConnectSolanaToken} from './wallet-connect-solana-token.js';

const DetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

const UnknownLabel = styled(InfoSectionItemLabel)`
  color: var(--color-text-caution);
`;

const AccountRole = styled.span`
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
`;

const AccountName = styled(InfoSectionItemLabel)`
  min-width: 0;
  overflow-wrap: anywhere;
`;

const Identifier = styled.span`
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  user-select: text;
`;

function SolanaInstruction({
  instruction,
  index,
  count,
  keys,
  chainId,
  decoding,
}: {
  instruction: SolanaInstructionReview;
  index: number;
  count: number;
  keys: readonly WalletKeyData[];
  chainId: string;
  decoding: boolean;
}): ReactNode {
  const {decoded, idl} = instruction;
  const tokenInstruction = isSolanaTokenInstruction(decoded);
  const name =
    decoded.kind === 'token-approve'
      ? 'Token approval'
      : decoded.kind === 'token-revoke'
        ? 'Revoke approval'
        : decoded.kind === 'token-account-create'
          ? 'Create token account'
          : decoded.kind === 'token-transfer'
            ? 'Token transfer'
            : decoded.kind === 'transfer'
              ? 'Transfer'
              : decoded.kind === 'unknown'
                ? (idl?.name ?? 'Instruction')
                : 'Compute budget';
  const dataContent = (
    <>
      <InfoSectionHeader>
        <InfoSectionItemLabel>Data</InfoSectionItemLabel>
        {decoding ? (
          <InfoSectionLoadingSpinner aria-label="Decoding instruction" />
        ) : (
          <CopyButton
            value={hexlify(instruction.data)}
            label="Copy instruction data"
          >
            {instruction.data.length} bytes
          </CopyButton>
        )}
      </InfoSectionHeader>
      {idl ? (
        <TypedDataFields
          fields={idl.fields}
          label={`${idl.name} arguments`}
          renderValue={field =>
            field.kind === 'value' && field.type === 'pubkey'
              ? {
                  block: true,
                  content: (
                    <ExpandableAddress>
                      {field.value as string}
                    </ExpandableAddress>
                  ),
                }
              : undefined
          }
        />
      ) : (
        <MessageContent aria-label="Instruction data (hex)">
          {hexlify(instruction.data)}
        </MessageContent>
      )}
    </>
  );

  return (
    <InfoSection>
      <MessageSectionHeader>
        <MessageSectionTitle>
          {name}
          {count > 1 && ` ${index + 1}/${count}`}
        </MessageSectionTitle>
        {instruction.token?.mint && (
          <SolanaTokenTag
            chainId={chainId}
            token={{...instruction.token, mint: instruction.token.mint}}
          />
        )}
        {decoded.kind === 'unknown' && !idl && !decoding && (
          <UnknownLabel>Unrecognized instruction</UnknownLabel>
        )}
        {idl && <InfoSectionItemLabel>IDL</InfoSectionItemLabel>}
      </MessageSectionHeader>
      {instruction.token?.warning && (
        <WarningMessage>{instruction.token.warning}</WarningMessage>
      )}
      {tokenInstruction ? (
        <WalletConnectSolanaToken
          decoded={decoded}
          token={instruction.token}
          chainId={chainId}
          keys={keys}
        />
      ) : decoded.kind === 'transfer' ? (
        <>
          <WalletAddressFieldset
            keys={keys}
            addressType="solana"
            address={decoded.from}
            label="From"
          />
          <WalletAddressFieldset
            keys={keys}
            addressType="solana"
            address={decoded.to}
            label="To"
          />
          <InfoFieldset $equalPadding>
            <InfoLegend>Amount</InfoLegend>
            <InfoFieldsetValue>
              <NativeAmount
                value={decoded.lamports}
                currency={{symbol: 'SOL', decimals: 9}}
              />
            </InfoFieldsetValue>
          </InfoFieldset>
        </>
      ) : decoded.kind === 'unknown' ? (
        <>
          <InfoFieldset>
            <InfoLegend>Program</InfoLegend>
            <ExpandableAddress>{instruction.programAddress}</ExpandableAddress>
          </InfoFieldset>
          {idl && dataContent}
          {!!instruction.accounts.length && (
            <InfoPanel aria-label="Instruction accounts">
              {instruction.accounts.map((account, accountIndex) => (
                <InfoSectionItem key={accountIndex}>
                  <InfoSectionHeader>
                    <AccountName>
                      {idl?.accountNames[accountIndex] ??
                        `Account ${accountIndex + 1}`}
                    </AccountName>
                    <AccountRole>
                      {account.isSigner && 'Signer · '}
                      {account.isWritable ? 'Writable' : 'Read-only'}
                    </AccountRole>
                  </InfoSectionHeader>
                  <ExpandableAddress>{account.address}</ExpandableAddress>
                </InfoSectionItem>
              ))}
            </InfoPanel>
          )}
          {!idl && dataContent}
        </>
      ) : (
        <InfoPanel>
          <InfoSectionRow>
            <InfoSectionItemLabel>
              {decoded.kind === 'compute-unit-limit'
                ? 'Compute unit limit'
                : 'Compute unit price'}
            </InfoSectionItemLabel>
            <span>
              {decoded.kind === 'compute-unit-limit' ? (
                decoded.units.toLocaleString(UI_LOCALE)
              ) : (
                <FormattedNumber
                  value={decoded.microLamports.toString()}
                  unit="µlamports / CU"
                />
              )}
            </span>
          </InfoSectionRow>
        </InfoPanel>
      )}
    </InfoSection>
  );
}

export const WalletConnectSolanaTransactions = observer(
  ({
    payload,
    reviews,
    decoding = false,
    simulations,
    showSimulation,
    onRefreshSimulation,
    selectedAddresses,
    onSelect,
    disabled,
  }: {
    payload: WalletConnectSolanaTransactionRequest;
    reviews?: readonly SolanaTransactionReview[];
    decoding?: boolean;
    simulations: readonly (SolanaTransactionSimulation | undefined)[];
    showSimulation: boolean;
    onRefreshSimulation: () => void;
    selectedAddresses: readonly (string | undefined)[];
    onSelect: (index: number, address: string) => void;
    disabled: boolean;
  }): ReactNode => {
    const {walletStorageService, solanaTokenService} = useEntrances();
    const [detailsIndex, setDetailsIndex] = useState<number>();
    const details =
      detailsIndex === undefined
        ? undefined
        : payload.transactions[detailsIndex].transaction;

    useEffect(() => {
      if (!reviews) return;
      void solanaTokenService.resolve(
        payload.chainId,
        reviews.flatMap(review =>
          review.instructions.flatMap(instruction =>
            instruction.token?.mint ? [instruction.token.mint] : [],
          ),
        ),
      );
    }, [reviews, payload.chainId, solanaTokenService]);

    return (
      <>
        {showSimulation && payload.transactions.length > 1 && (
          <InfoMessage>
            Each transaction is simulated independently, without changes from
            the others.
          </InfoMessage>
        )}
        {payload.transactions.map(({transaction, addresses}, index) => {
          const review = reviews?.[index];
          const selectedAddress = selectedAddresses[index];

          return (
            <InfoSection key={index}>
              <InfoSectionHeader>
                <WhiteTag>
                  Transaction
                  {payload.transactions.length > 1 &&
                    ` ${index + 1}/${payload.transactions.length}`}
                </WhiteTag>
                <DetailsButton
                  aria-label={`Transaction ${index + 1} details`}
                  aria-haspopup="dialog"
                  onClick={() => setDetailsIndex(index)}
                  disabled={disabled}
                >
                  <AppIcon icon={list} aria-hidden="true" />
                </DetailsButton>
              </InfoSectionHeader>
              {addresses.length === 1 ? (
                <WalletAccountFieldset
                  keys={walletStorageService.keys}
                  addressType="solana"
                  address={addresses[0]}
                  label="Signer"
                />
              ) : (
                <InfoFieldset>
                  <InfoLegend>Choose signer</InfoLegend>
                  <WalletAccountList
                    keys={walletStorageService.keys}
                    addressType="solana"
                    addresses={addresses}
                    selectedAddresses={
                      new Set(selectedAddress ? [selectedAddress] : [])
                    }
                    onToggle={address => onSelect(index, address)}
                    disabled={disabled}
                    compact
                    compactContent
                    contained
                  />
                </InfoFieldset>
              )}
              {transaction.feePayer !== selectedAddress && (
                <WalletAddressFieldset
                  keys={walletStorageService.keys}
                  addressType="solana"
                  address={transaction.feePayer}
                  label="Fee payer"
                />
              )}
              {review?.instructions.map((instruction, instructionIndex) => (
                <SolanaInstruction
                  key={instructionIndex}
                  instruction={instruction}
                  index={instructionIndex}
                  count={review.instructions.length}
                  keys={walletStorageService.keys}
                  chainId={payload.chainId}
                  decoding={decoding && instruction.decoded.kind === 'unknown'}
                />
              ))}
              {review && showSimulation && (
                <SolanaTransactionSimulationSection
                  result={simulations[index]}
                  onRefresh={onRefreshSimulation}
                  disabled={disabled}
                />
              )}
            </InfoSection>
          );
        })}
        {details && (
          <DetailsPopup
            aria-label="Transaction details"
            onDismiss={() => setDetailsIndex(undefined)}
          >
            <DetailsPopupTitle>Transaction details</DetailsPopupTitle>
            <DetailsPopupDivider />
            <InfoSectionRow>
              <InfoSectionItemLabel>Version</InfoSectionItemLabel>
              <span>
                {details.compiled.version === 'legacy' ? 'Legacy' : 'v0'}
              </span>
            </InfoSectionRow>
            <InfoSectionRow>
              <InfoSectionItemLabel>Message size</InfoSectionItemLabel>
              <span>{details.messageBytes.length} bytes</span>
            </InfoSectionRow>
            <InfoSectionItem>
              <InfoSectionItemLabel>Blockhash / nonce</InfoSectionItemLabel>
              <Identifier>{details.compiled.lifetimeToken}</Identifier>
            </InfoSectionItem>
          </DetailsPopup>
        )}
      </>
    );
  },
);
