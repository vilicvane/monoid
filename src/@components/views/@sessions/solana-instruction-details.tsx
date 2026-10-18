import {hexlify} from 'ethers';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {SolanaInstructionReview} from '../../../@lib/solana-transaction-review.js';
import {CopyButton} from '../../@ui/copy-button.js';
import {DetailsPopupSection} from '../../@ui/details-popup.js';
import {ExpandableAddress} from '../../@ui/expandable-address.js';
import {
  InfoSectionHeader,
  InfoSectionItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
} from '../../@ui/info-section.js';
import {MessageContent} from '../../@ui/message-content.js';
import {PopupAddress} from '../../@ui/popup-address.js';

const AccountRole = styled.span`
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
`;

const AccountName = styled(InfoSectionItemLabel)`
  min-width: 0;
  overflow-wrap: anywhere;
`;

const Data = styled(MessageContent)`
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
`;

export function getSolanaInstructionName({
  decoded,
  idl,
}: SolanaInstructionReview): string {
  switch (decoded.kind) {
    case 'token-approve':
      return 'Token approval';
    case 'token-revoke':
      return 'Revoke approval';
    case 'token-account-create':
      return decoded.idempotent
        ? 'Prepare token account'
        : 'Create token account';
    case 'token-transfer':
      return 'Token transfer';
    case 'transfer':
      return 'Transfer';
    case 'compute-unit-limit':
      return 'Compute unit limit';
    case 'compute-unit-price':
      return 'Compute unit price';
    case 'unknown':
      return idl?.name ?? 'Instruction';
  }
}

export function SolanaInstructionAccounts({
  instruction,
  popup = false,
}: {
  instruction: SolanaInstructionReview;
  popup?: boolean;
}): ReactNode {
  const Address = popup ? PopupAddress : ExpandableAddress;

  return instruction.accounts.map((account, index) => (
    <InfoSectionItem key={index}>
      <InfoSectionHeader>
        <AccountName>
          {instruction.idl?.accountNames[index] ?? `Account ${index + 1}`}
        </AccountName>
        <AccountRole>
          {account.isSigner && 'Signer · '}
          {account.isWritable ? 'Writable' : 'Read-only'}
        </AccountRole>
      </InfoSectionHeader>
      <Address highlightEdges={account.isSigner}>{account.address}</Address>
    </InfoSectionItem>
  ));
}

export function SolanaInstructionDetails({
  instruction,
  index,
}: {
  instruction: SolanaInstructionReview;
  index: number;
}): ReactNode {
  return (
    <DetailsPopupSection>
      <InfoSectionHeader>
        <InfoSectionItemContent>
          {getSolanaInstructionName(instruction)}
        </InfoSectionItemContent>
        <InfoSectionItemLabel>#{index + 1}</InfoSectionItemLabel>
      </InfoSectionHeader>
      <InfoSectionItem>
        <InfoSectionItemLabel>Program</InfoSectionItemLabel>
        <PopupAddress>{instruction.programAddress}</PopupAddress>
      </InfoSectionItem>
      <SolanaInstructionAccounts instruction={instruction} popup />
      <InfoSectionItem>
        <InfoSectionHeader>
          <InfoSectionItemLabel>Data</InfoSectionItemLabel>
          <CopyButton
            value={hexlify(instruction.data)}
            label="Copy instruction data"
          >
            {instruction.data.length} bytes
          </CopyButton>
        </InfoSectionHeader>
        <Data>{hexlify(instruction.data)}</Data>
      </InfoSectionItem>
    </DetailsPopupSection>
  );
}
